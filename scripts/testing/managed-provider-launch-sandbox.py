#!/usr/bin/env python3
"""Closed actual OpenCode controller/supervisor/host startup qualification."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

IMAGE="sha256:967627e41734aa903e824e4be22849c7f22ce0e69487ce61bb72004c4817f89c"
TEST="managed_provider_launch_tests::managed_provider_opencode_terminal_and_fresh_native_startup_consumes_prepared_inputs"
CODEX_TEST="managed_provider_launch_tests::managed_provider_codex_terminal_and_fresh_native_startup_consumes_prepared_inputs"
LABEL="com.freshell.provider-launch-probe"

def docker(*args,check=True,timeout=180):
    return subprocess.run(["docker",*args],text=True,capture_output=True,timeout=timeout,check=check)

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-binary",type=Path,required=True)
    parser.add_argument("--host-binary",type=Path,required=True)
    parser.add_argument("--broker-binary",type=Path,required=True)
    parser.add_argument("--receipt-dir",type=Path,required=True)
    parser.add_argument("--provider",choices=["opencode","codex"],default="opencode")
    args=parser.parse_args()
    selected_test=CODEX_TEST if args.provider=="codex" else TEST
    repo=Path(__file__).resolve().parents[2]
    test=args.test_binary.resolve(strict=True);host=args.host_binary.resolve(strict=True);broker=args.broker_binary.resolve(strict=True)
    if test.parent!=repo/"target/debug/deps" or not re.fullmatch(r"freshell_server-[a-f0-9]{16}",test.name) or host!=repo/"target/debug/freshell-session-host" or broker!=repo/"target/managed-provider-launch-broker.mjs" or not args.receipt_dir.is_dir():
        raise RuntimeError("closed startup requires this worktree's exact compiled artifacts and existing receipts")
    listing=subprocess.run([str(test),"--exact",selected_test,"--list"],env={"PATH":"/usr/bin:/bin"},text=True,capture_output=True,timeout=20,check=True)
    if f"{selected_test}: test" not in listing.stdout.splitlines():
        raise RuntimeError("closed startup compiled test is missing")
    info=json.loads(docker("info","--format","{{json .}}").stdout)
    if "name=rootless" not in info["SecurityOptions"] or docker("image","inspect","--format","{{.Id}}",IMAGE).stdout.strip()!=IMAGE:
        raise RuntimeError("closed startup requires the qualified rootless daemon and exact cached image")
    endpoint=json.loads(docker("context","inspect").stdout)[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://"):
        raise RuntimeError("closed startup requires the existing local rootless daemon IPC")
    run="freshell-launch-"+uuid.uuid4().hex;installation=str(uuid.uuid4());owned=[]
    receipt={"runId":run,"image":IMAGE,"test":selected_test,"provider":args.provider,"rootless":True,"testArtifactSha256":digest(test),"hostArtifactSha256":digest(host),"brokerArtifactSha256":digest(broker)}
    volumes=set()
    def remove(name):
        result=docker("container","inspect",name,check=False)
        if result.returncode:
            return
        value=json.loads(result.stdout)[0]
        labels=value["Config"].get("Labels",{})
        known_helpers=[]
        if labels.get("com.freshell.installation-id")==installation:
            for candidate in (root/"handoff").glob("*.json"):
                metadata=json.loads(candidate.read_text())
                if labels.get("com.freshell.soul-id")==metadata["soulId"] and labels.get("com.freshell.incarnation-id")==metadata["incarnationId"]:
                    known_helpers.append(metadata)
        fixed_helper=value["Config"].get("Image")==IMAGE and value["Config"].get("Cmd") in [["publish-provider-inputs"],["prepare-provider-mountpoints"]] and bool(known_helpers)
        if fixed_helper:
            receipt.setdefault("helperInspections",[]).append({
                "id":value["Id"],"image":value["Config"]["Image"],"user":value["Config"]["User"],
                "entrypoint":value["Config"]["Entrypoint"],"command":value["Config"]["Cmd"],
                "labels":labels,"mounts":value["HostConfig"].get("Mounts"),"logConfig":value["HostConfig"].get("LogConfig"),
                "tty":value["Config"].get("Tty"),"exitCode":value["State"].get("ExitCode"),
                "environment": [{"name":entry.split("=",1)[0],"empty":entry.endswith("=")} for entry in value["Config"].get("Env",[])],
            })
        if labels.get(LABEL)!=run and labels.get("com.freshell.runtime-test-run-id")!=run and not fixed_helper:
            raise RuntimeError("closed startup container cleanup ownership changed")
        docker("rm","--force",value["Id"])
    def create(name,*arguments):
        owned.append(name)
        docker("create","--name",name,"--label",f"{LABEL}={run}","--read-only","--security-opt","no-new-privileges:true",
               "--pids-limit","256","--memory","2g",*arguments)
    with tempfile.TemporaryDirectory(prefix=run+"-") as temporary, tempfile.TemporaryDirectory(prefix="fl-"+uuid.uuid4().hex[:8]+"-") as ipc:
        # Keep an exact UUID-only basename for both trusted and fixture checks.
        root=Path(temporary).with_name("fln-"+uuid.uuid4().hex[:16])
        Path(temporary).rename(root)
        try:
            for name in ["workspace","source-home/.config/opencode","grants","handoff","tmp","scenarios"]:
                (root/name).mkdir(parents=True,exist_ok=True)
            initial=[]
            for soul in ["soul-terminal-"+hashlib.sha256(b"closed-native-terminal-create").hexdigest()[:32],"soul-fresh-"+args.provider+"-"+hashlib.sha256(b"closed-native-fresh-create").hexdigest()[:32]]:
                volume="freshell-provider-"+hashlib.sha256((installation+"\0"+soul).encode()).hexdigest()[:24]
                volumes.add(volume)
                initial.append({"installationId":installation,"soulId":soul,"providerVolumeName":volume,"imageRef":IMAGE,"hostBinaryPath":str(host),"binarySha256":digest(host),"daemonId":info["ID"]})
            (root/"broker-configuration.json").write_text(json.dumps({"imageRef":IMAGE,"hostBinaryPath":str(host),"runId":run,"provider":args.provider,"initialVolumes":initial}))
            setup=run+"-dependencies"
            # Install the actual exact published SDK tree into synthetic config
            # storage. No read-only install bypass, fake SDK or model call.
            if args.provider=="opencode":
                create(setup,"--network","bridge","--user","0:0","--cap-drop","ALL",
                       "--mount",f"type=bind,src={root},dst={root}","--tmpfs","/tmp:rw,nosuid,nodev,size=128m",
                       "--env",f"HOME={root}/source-home","--entrypoint","/usr/local/bin/npm",IMAGE,
                       "install","--prefix",str(root/"source-home/.config/opencode"),"@opencode-ai/plugin@1.18.21")
                outcome=docker("start","--attach",setup,check=False)
                if outcome.returncode:
                    raise RuntimeError("closed startup actual SDK dependency preparation failed")
                remove(setup)
            writable=run+"-workspace-mode"
            create(writable,"--network","none","--user","0:0","--cap-drop","ALL",
                   "--mount",f"type=bind,src={root},dst={root}","--entrypoint","/usr/bin/chmod",IMAGE,
                   "0770",str(root/"workspace"))
            docker("start","--attach",writable)
            remove(writable)
            config=root/"source-home/.config/opencode"
            plugin=config/"plugins/probe-server";plugin.mkdir(parents=True)
            (plugin/"resource.txt").write_text("plugin-relative-resource")
            (plugin/"dependency.mjs").write_text("export const value='plugin-actual-local-dependency';\n")
            (plugin/"index.mjs").write_text("""import fs from 'node:fs';import crypto from 'node:crypto';import {tool} from '@opencode-ai/plugin';import {value} from './dependency.mjs';
const hash=(value)=>crypto.createHash('sha256').update(value).digest('hex');
export default {id:'closed-native-fixture',async server(input,options){return {async config(config){
 const receipt={prompt:hash(config.agent.probe.prompt),description:hash(config.agent.probe.description),references:['third','fourth','fifth','sixth'].map(name=>hash(config.agent[name].prompt)),resource:hash(fs.readFileSync(new URL('./resource.txt',import.meta.url))),dependency:hash(value),sdk:hash(typeof tool),snapshotDisabled:config.snapshot===false};
 fs.writeFileSync(options.receipt,JSON.stringify(receipt));
},async 'chat.message'(){
 fs.writeFileSync(options.receipt+'.stopped','FRESHELL_SYNTHETIC_STARTUP_STOP');
 throw new Error('FRESHELL_SYNTHETIC_STARTUP_STOP');
}}}};
""")
            syntax=subprocess.run(["node","--check",str(plugin/"index.mjs")],text=True,capture_output=True,timeout=20)
            if syntax.returncode:
                raise RuntimeError("closed startup synthetic plugin syntax invalid")
            (config/"rules.txt").write_text("native-rule\n");(config/"second.txt").write_text("native-second-rule\n")
            agents={"probe":{"prompt":"{env:OPENAI_API_KEY}","description":"{file:{env:RULE_DIR}/second.txt}"}}
            for ordinal in ["third","fourth","fifth","sixth"]:
                (config/f"{ordinal}.txt").write_text(f"native-{ordinal}-rule\n")
                agents[ordinal]={"prompt":"{file:./"+ordinal+".txt}"}
            (config/"opencode.json").write_text(json.dumps({"agent":agents,"plugin":[["./plugins/probe-server/index.mjs",{"receipt":str(root/"workspace/native-consumed.json")}]]}))
            (root/"grants/environment.env").write_text("OPENAI_API_KEY=synthetic-onecli-shadowed\nNODE_EXTRA_CA_CERTS=/home/freshell/provider/.config/onecli/gateway-ca.pem\n")
            (root/"grants/ca.pem").write_bytes((repo/"test/e2e-browser/fixtures/tls/ca.cert.pem").read_bytes())
            (root/"grants/auth.json").write_text(json.dumps({"fixture":{"type":"wellknown","key":"OPENAI_API_KEY","token":"AUTH_PREFIX{file:./rules.txt}AUTH_SUFFIX"}}))
            # These newly created synthetic grants alone receive private mode.
            (root/"grants/environment.env").chmod(0o600);(root/"grants/auth.json").chmod(0o600)
            (root/"grants/ca.pem").chmod(0o600)
            broker_name=run+"-broker"
            create(broker_name,"--network","none","--user","0:0","--cap-drop","ALL",
                   "--mount",f"type=bind,src={root},dst={root}",
                   "--mount",f"type=bind,src={ipc},dst={ipc}",
                   "--mount",f"type=bind,src={endpoint[7:]},dst=/run/fixture-docker.sock,readonly",
                   "--mount",f"type=bind,src={broker},dst=/runtime/startup-broker.mjs,readonly",
                   "--env",f"FRESHELL_PROVIDER_LAUNCH_FIXTURE={root}","--env",f"TMPDIR={ipc}",
                   "--entrypoint","/usr/local/bin/node",IMAGE,"/runtime/startup-broker.mjs")
            docker("start",broker_name)
            deadline=time.monotonic()+20
            while not (root/"broker.sock").exists() and time.monotonic()<deadline:
                time.sleep(.05)
            if not (root/"broker.sock").exists():
                raise RuntimeError("closed startup trusted broker unavailable")
            controller=run+"-controller"
            create(controller,"--network","bridge","--user","0:0","--cap-drop","ALL",
                   "--mount",f"type=bind,src={root},dst={root}","--mount",f"type=bind,src={test},dst=/runtime/startup-tests,readonly",
                   "--mount",f"type=bind,src={ipc},dst={ipc}",
                   "--mount",f"type=bind,src={host},dst={host},readonly",
                   "--env",f"HOME={root}/source-home","--env",f"TMPDIR={ipc}",
                   "--env",f"RULE_DIR={config}","--env",f"FRESHELL_PROVIDER_LAUNCH_FIXTURE={root}",
                   "--env",f"FRESHELL_PROVIDER_LAUNCH_HOST_BINARY={host}","--env",f"FRESHELL_PROVIDER_LAUNCH_IMAGE={IMAGE}",
                   "--env",f"FRESHELL_PROVIDER_LAUNCH_INSTALLATION={installation}","--env",f"FRESHELL_PROVIDER_LAUNCH_RUN_ID={run}",
                   "--env",f"FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE={root}/grants/environment.env",
                   "--env",f"FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE={root}/grants/auth.json",
                   "--env",f"FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE={root}/grants/ca.pem",
                   "--entrypoint","/runtime/startup-tests",IMAGE,"--exact",selected_test,"--nocapture","--test-threads","1")
            docker("start",controller)
            controller_metadata=json.loads(docker("container","inspect",controller).stdout)[0]
            gateway=controller_metadata["NetworkSettings"]["Networks"]["bridge"]["IPAddress"]
            if not gateway:
                raise RuntimeError("closed controller has no owned bridge gateway")
            (root/"controller-gateway.json").write_text(json.dumps({"address":gateway}))
            waited=docker("wait",controller)
            exit_code=int(waited.stdout.strip())
            outcome=docker("logs",controller,check=False)
            receipt["exitCode"]=exit_code
            receipt["consumedRoutes"]=[json.loads(line.split("provider_launch_consumer ",1)[1]) for line in outcome.stdout.splitlines() if "provider_launch_consumer " in line]
            print(outcome.stdout,end="",flush=True);print(outcome.stderr,end="",flush=True)
            expected_routes={("opencode","terminal"),("opencode","fresh"),("opencode","terminal-tui")} if args.provider=="opencode" else {("codex","terminal"),("codex","fresh")}
            observed_routes={(item.get("provider"),item.get("route")) for item in receipt["consumedRoutes"]}
            if exit_code==0 and (len(receipt["consumedRoutes"])!=len(expected_routes) or observed_routes!=expected_routes or "test result: ok. 1 passed;" not in outcome.stdout):
                receipt["exitCode"]=2;receipt["failureClass"]="native_startup_count_mismatch"
            (root/"broker-complete").write_text("ok")
            deadline=time.monotonic()+10
            while not (root/"broker-receipt.json").exists() and time.monotonic()<deadline:
                time.sleep(.05)
            if (root/"broker-receipt.json").is_file():
                evidence=json.loads((root/"broker-receipt.json").read_text())
                receipt["broker"]=evidence
                for value in evidence["receipts"]:owned.append(value["containerId"])
            else:
                receipt["exitCode"]=2;receipt["failureClass"]="broker_receipt_unavailable"
        finally:
            # Get only this run's objects, then inspect exact labels and use
            # full IDs. The fixture never receives this raw Docker interface.
            listed=docker("ps","--all","--quiet","--no-trunc","--filter",f"label=com.freshell.runtime-test-run-id={run}",check=False)
            owned.extend(listed.stdout.splitlines())
            helpers=docker("ps","--all","--quiet","--no-trunc","--filter",f"label=com.freshell.installation-id={installation}",check=False)
            owned.extend(helpers.stdout.splitlines())
            for name in reversed(owned):remove(name)
            for candidate in (root/"handoff").glob("*.json"):
                value=json.loads(candidate.read_text())
                if value.get("indexedFiles"):volumes.add(value["indexedFiles"]["volumeName"])
            for volume in volumes:
                inspected=docker("volume","inspect",volume,check=False)
                if inspected.returncode:continue
                value=json.loads(inspected.stdout)[0]
                preparations=[json.loads(candidate.read_text()) for candidate in (root/"handoff").glob("*.json")]
                labels=None
                for prepared in preparations:
                    if volume==prepared["providerVolumeName"]:
                        source=next(item for item in initial if item["providerVolumeName"]==volume)
                        labels={"com.freshell.installation-id":installation,"com.freshell.soul-id":prepared["soulId"],
                                "freshell.input.reservation":prepared["initialAuthReservation"],"freshell.input.incarnation":prepared["incarnationId"],
                                "freshell.input.intent":"1","freshell.input.daemon":source["daemonId"],"freshell.input.image":IMAGE,
                                "freshell.input.binary-sha256":source["binarySha256"]}
                    elif (prepared.get("indexedFiles") or {}).get("volumeName")==volume:
                        labels={"com.freshell.managed-inputs":"true","com.freshell.installation-id":installation,
                                "com.freshell.soul-id":prepared["soulId"],"com.freshell.incarnation-id":prepared["incarnationId"],
                                "com.freshell.input-generation":prepared["generationId"]}
                if labels is None or value.get("Driver")!="local" or value.get("Labels")!=labels:
                    raise RuntimeError("closed startup volume cleanup ownership changed")
                docker("volume","rm",volume)
            receipt["ownedCleanup"]=all(docker("container","inspect",name,check=False).returncode!=0 for name in owned) and all(docker("volume","inspect",volume,check=False).returncode!=0 for volume in volumes)
            (args.receipt_dir/f"task002-native-{args.provider}-launch.json").write_text(json.dumps(receipt,sort_keys=True)+"\n")
            # Rename back so TemporaryDirectory removes only its owned scratch.
            root.rename(temporary)
    if not receipt.get("ownedCleanup"):
        raise RuntimeError("closed startup cleanup incomplete")
    raise SystemExit(receipt.get("exitCode",2))

if __name__=="__main__":
    main()
