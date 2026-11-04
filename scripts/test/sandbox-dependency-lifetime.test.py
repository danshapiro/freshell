#!/usr/bin/env python3
"""Behavioral Docker checks for immutable, input-specific sandbox dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import time
import tarfile
import traceback
import traceback
import uuid

REPO = Path(__file__).resolve().parents[2]
LABEL = "org.freshell.dependency-test"
FOUNDATION = "com.freshell.sandbox.dependency-foundation"
PROTOCOL = "com.freshell.sandbox.dependency-protocol"
CASES = ("singleflight", "coherence", "readonly", "reuse", "failure",
         "interruption", "legacy", "inputs-during-prepare", "node-linker-input", "admission",
         "standard-builder", "phase-image", "phase-input", "cache-collision", "cache-file", "non-git-default")


def require(value, message):
    if not value:
        raise AssertionError(message)


def write(path, value, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    path.chmod(mode)


def wait_for(predicate, jobs=(), timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        require(all(job["process"].poll() is None for job in jobs),
                "fixture exited before its acknowledged barrier")
        time.sleep(.02)  # Bounded barrier polling, never a timing assertion.
    raise AssertionError("fixture barrier deadline exceeded")


def process_identity(pid):
    proc = Path("/proc") / str(pid)
    try:
        return (proc.joinpath("stat").read_text().rpartition(") ")[2]
                .split()[19])
    except FileNotFoundError:
        return None


INSTALL = r"""
const fs = require('node:fs');
const control = 'controls/';
fs.appendFileSync(control+'installs.jsonl', JSON.stringify({pid:process.pid})+'\n');
const mode = fs.readFileSync(control+'mode','utf8').trim();
if (mode === 'pass') process.exit(0);
fs.writeFileSync(control+'install.entered','');
const deadline = Date.now()+120000;
const timer = setInterval(()=>{
  if (fs.existsSync(control+'install.release')) {
    clearInterval(timer); process.exit(mode === 'fail' ? 23 : 0);
  }
  if (Date.now()>deadline) process.exit(24);
}, 20);
"""

READER = r"""
const fs=require('node:fs'),cp=require('node:child_process');
const assert=require('node:assert/strict');
const [name,value,watch]=process.argv.slice(2);
const prefix='controls/'+name;
let imports=0,sequence=0;
function fresh(){
  cp.execFileSync(process.execPath,['-e',
    "require('node:assert/strict').equal(require('sandbox-marker'),"+
    JSON.stringify(value)+")"],{cwd:process.cwd(),stdio:'pipe',timeout:10000});
  imports++;
}
function receipt(){
  const state=fs.readFileSync('node_modules/.sandbox-deps-state','utf8');
  const key=(state.match(/^cache_identity=(.+)$/m)||[])[1]||null;
  fs.writeFileSync(prefix+'.ack.tmp',JSON.stringify({sequence,imports,key,state}));
  fs.renameSync(prefix+'.ack.tmp',prefix+'.ack');
}
fresh(); receipt(); fs.writeFileSync(prefix+'.entered','');
if(watch==='watch'){
  const timer=setInterval(()=>{
    if(fs.existsSync(prefix+'.request')){
      const next=Number(fs.readFileSync(prefix+'.request','utf8'));
      if(next>sequence){fresh();sequence=next;receipt();}
    }
    if(fs.existsSync(prefix+'.release')) clearInterval(timer);
  },20);
}
"""

TOOL = r"""#!/usr/bin/env node
const fs=require('node:fs'),assert=require('node:assert/strict');
const path=require('node:path');
for(const cache of ['.vite','.vite-temp','.vitest','.cache']){
  const logical=path.join('node_modules',cache);
  const real=fs.realpathSync(logical);
  assert(real.startsWith('/workspace/target/.freshell-node-cache/root/'));
  fs.mkdirSync(path.join(logical,'fixture-tool'),{recursive:true});
  const file=path.join(logical,'fixture-tool','probe');
  fs.writeFileSync(file,'usable');assert.equal(fs.readFileSync(file,'utf8'),'usable');
}
let denied=false;
try{fs.writeFileSync('node_modules/forbidden-root-mutation','bad')}
catch(e){assert.equal(e.code,'EROFS');denied=true}
assert(denied,'prepared dependency root was writable');
assert.equal(require('sandbox-marker'),'A');
"""

PHASE_DOCKER = r"""#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
args = sys.argv[1:]
docker = os.environ['FIXTURE_REAL_DOCKER']
project = Path(os.environ['FIXTURE_PHASE_PROJECT'])
result = subprocess.run([docker, *args])
if args and args[0] == 'run':
    preparing = os.getenv('FRESHELL_SANDBOX_PREPARE_ONLY') == '1'
    with (project / 'controls/phases.jsonl').open('a') as stream:
        stream.write(json.dumps({'prepare': preparing, 'image': args[-4]}) + '\n')
    if result.returncode == 0 and preparing:
        if os.environ['FIXTURE_PHASE_CHANGE'] == 'phase-image':
            subprocess.run([docker, 'tag', os.environ['FIXTURE_REPLACEMENT_IMAGE'],
                            os.environ['FIXTURE_MUTABLE_IMAGE']], check=True)
        else:
            (project / '.npmrc').write_text('prefer-offline=true\n')
sys.exit(result.returncode)
"""


class Fixture:
    def __init__(self, args, case):
        self.args, self.case = args, case
        self.token = uuid.uuid4().hex[:12]
        self.prefix = "freshell-deptest-" + self.token
        self.root = args.temp_root / (case + "-" + self.token)
        self.results = args.results / (case + "-" + self.token)
        self.root.mkdir(mode=0o700)
        self.results.mkdir(mode=0o700)
        self.projects, self.jobs, self.direct, self.images = [], [], [], {}
        self.standard_images = set()
        self.standard_foundations = {}
        self.containers, self.targets = {}, {}
        self.command_count = 0
        require(not self.capture(["docker", "volume", "ls", "--format",
                    "{{.Name}}", "--filter", "name=^"+self.prefix+"-"]).strip(),
                "task volume prefix already existed")

    def capture(self, argv, okay=True, timeout=180, **kwargs):
        self.command_count += 1
        log = self.results / ("%04d.log" % self.command_count)
        result = subprocess.run(argv, text=True, capture_output=True,
                                timeout=timeout, **kwargs)
        write(log, result.stdout+"\n"+result.stderr, 0o600)
        if okay:
            require(result.returncode == 0, "command failed; see private log")
        return result.stdout if okay else result

    def image(self, image):
        return json.loads(self.capture(["docker", "image", "inspect", image]))[0]

    def direct_run(self, image, arguments, command, network="none", okay=True):
        name = self.prefix+"-helper-"+str(len(self.direct))
        self.direct.append(name)  # Register before Docker can create it.
        return self.capture(["docker", "run", "--rm", "--init", "--name", name,
            "--label", LABEL+"="+self.token, "--network", network,
            "--memory", "8g", "--memory-swap", "16g", "--pids-limit", "512",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            *arguments, image, *command], okay=okay)

    def project(self, name, value="A", git=True):
        root = self.root / name
        root.mkdir(mode=0o755)
        for relative in ("scripts/sandbox-test.sh",
                         "scripts/testing/sandbox-owner-guard.py",
                         "docker/sandbox/protocol.json",
                         "docker/sandbox/dependency-cache.mjs"):
            source = (self.args.wrapper_source if relative == "scripts/sandbox-test.sh"
                      else self.args.identity_source if relative == "docker/sandbox/dependency-cache.mjs"
                      else REPO / relative)
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)  # Four support files, no tree copies.
            target.chmod(0o644)
        controls = root / "controls"
        controls.mkdir(mode=0o777)
        controls.chmod(0o777)
        write(controls / "mode", "pass", 0o666)
        write(root / "package.json", json.dumps({
            "name":"sandbox-dependency-fixture-"+value.lower(),"version":"1.0.0","private":True,
            "packageManager":"pnpm@10.34.5",
            "scripts":{"preinstall":"node scripts/install.cjs"},
            "dependencies":{"sandbox-marker":"file:./marker"}}))
        write(root / "marker/package.json", json.dumps({
            "name":"sandbox-marker","version":"1.0.0","main":"index.cjs",
            "bin":{"fixture-cache-tool":"tool.cjs"}}))
        write(root / "marker/index.cjs", "module.exports="+json.dumps(value))
        write(root / "marker/tool.cjs", TOOL, 0o755)
        write(root / "scripts/install.cjs", INSTALL)
        write(root / "scripts/reader.cjs", READER)
        if git:
            self.capture(["git","init","--quiet",str(root)])
        owner = self.direct_run(self.args.image,
            ["--read-only","--entrypoint","stat","-v",str(root)+":/fixture:ro"],
            ["-c","%u:%g","/fixture"]).strip()
        self.direct_run(self.args.image,
            ["--read-only","--tmpfs","/tmp:rw,size=64m","--user",owner,
             "--entrypoint","bash","-e","HOME=/tmp",
             "-v",str(root)+":/fixture","--workdir","/fixture"],
            ["-ec","pnpm install --lockfile-only --ignore-scripts "
             "--store-dir /tmp/pnpm-store"])
        for directory in root.rglob("*"):
            if directory.is_dir() and directory != controls:
                directory.chmod(0o755)
        digest = hashlib.sha256(str(root.resolve()).encode()).hexdigest()
        volume = "freshell-sandbox-rust-target-v1-"+digest[:24]
        existing = self.capture(["docker","volume","inspect",volume], okay=False)
        require(existing.returncode != 0, "fixture target already existed")
        self.targets[volume] = digest
        self.projects.append(root)
        return root

    def control(self, project, name, value=""):
        write(project / "controls" / name, value, 0o666)

    def installs(self, project):
        file = project / "controls/installs.jsonl"
        return len(file.read_text().splitlines()) if file.exists() else 0

    def start(self, project, name, command=None, image=None, watch=False,
              extra_env=None, runtime=True):
        require(re.fullmatch("[a-z0-9-]+", name), "invalid fixture name")
        control = self.root / ("owner-"+name)
        control.mkdir(mode=0o700)
        log = self.results / (name+".log")
        stream = log.open("w")
        log.chmod(0o600)
        env = os.environ.copy()
        for key in ("FRESHELL_SANDBOX_DEPENDENCIES_READY",
                    "FRESHELL_SANDBOX_PREPARE_ONLY",
                    "FRESHELL_SANDBOX_EXTERNAL_BROWSER_PHASE",
                    "FRESHELL_SANDBOX_P2_G01_RUN_ID",
                    "FRESHELL_SANDBOX_P2_G01_PNPM_STORE_VOLUME"):
            env.pop(key, None)
        env.update(FRESHELL_SANDBOX_IMAGE=image or self.args.image,
                   FRESHELL_SANDBOX_CACHE_PREFIX=self.prefix,
                   FRESHELL_SANDBOX_OWNER_GUARD="1", TMPDIR=str(control))
        env.update(extra_env or {})
        if command is None:
            value = json.loads((project / "marker/index.cjs").read_text()
                               .removeprefix("module.exports="))
            command = shlex.join(["node","scripts/reader.cjs",name,value,
                                  "watch" if watch else "once"])
        proc = subprocess.Popen(["bash",str(project/"scripts/sandbox-test.sh"),
                                 *(["--runtime-suite"] if runtime else []),command], cwd=REPO,
                                env=env,stdout=stream,stderr=subprocess.STDOUT)
        job = dict(process=proc,identity=process_identity(proc.pid),
                   project=project,control=control,name=name,stream=stream)
        self.jobs.append(job)
        return job

    def observe(self, job):
        for file in job["control"].glob("freshell-sandbox-*/container.name"):
            name = file.read_text().strip()
            result = self.capture(["docker","container","inspect",name], okay=False)
            if result.returncode:
                continue
            item = json.loads(result.stdout)[0]
            require(item["Name"] == "/"+name, "container name changed")
            mount = next((m for m in item["Mounts"]
                          if m["Destination"] == "/workspace"), None)
            require(mount and mount["Source"] == str(job["project"]),
                    "container workspace ownership mismatch")
            self.containers[item["Id"]] = (name,str(job["project"]))
            if item["State"]["Running"]:
                return item
        return None

    def entered(self, job):
        wait_for(lambda: (job["project"]/"controls"/
                         (job["name"]+".entered")).exists(), [job])
        return self.observe(job)

    def root_volume(self, item):
        mount = next(m for m in item["Mounts"]
                     if m["Destination"] == "/workspace/node_modules")
        require(mount["Name"].startswith(self.prefix+"-"),
                "dependency volume outside task prefix")
        return mount["Name"]

    def ack(self, job):
        return json.loads((job["project"]/"controls"/
                           (job["name"]+".ack")).read_text())

    def round(self, job, number):
        self.control(job["project"],job["name"]+".request",str(number))
        wait_for(lambda: self.ack(job)["sequence"] == number, [job])
        require(self.ack(job)["imports"] >= number+1, "fresh import did not run")

    def finish(self, job, expected=0):
        status = job["process"].wait(timeout=180)
        require(status == expected if expected is not None else status != 0,
                "unexpected wrapper result")
        require(not list(job["control"].glob("freshell-sandbox-*")),
                "wrapper or owner guard retained unsettled control state")
        return status

    def release(self, job):
        self.control(job["project"],job["name"]+".release")
        self.finish(job)

    def terminate(self, job):
        proc = job["process"]
        require(process_identity(proc.pid) == job["identity"] != None,
                "wrapper PID identity changed")
        require(Path("/proc/"+str(proc.pid)+"/cwd").resolve() == REPO,
                "wrapper cwd changed")
        require(str(job["project"]/"scripts/sandbox-test.sh").encode() in
                Path("/proc/"+str(proc.pid)+"/cmdline").read_bytes(),
                "wrapper command identity changed")
        proc.send_signal(signal.SIGTERM)

    def state_absent(self, volume):
        self.direct_run(self.args.image,
            ["--read-only","--entrypoint","bash","-v",volume+":/modules:ro"],
            ["-ec","test ! -e /modules/.sandbox-deps-state"])

    def build(self, name, dockerfile):
        tag = "freshell-sandbox:deptest-"+self.token+"-"+name
        require(self.capture(["docker","image","inspect",tag],okay=False)
                .returncode != 0, "task image tag already existed")
        self.images[tag] = None  # Register before publication/CLI acknowledgement.
        context = self.root / ("build-"+name)
        context.mkdir()
        write(context / "Dockerfile",dockerfile)
        self.capture(["docker","build","--pull=false","--network=none",
            "--label",LABEL+"="+self.token,"-t",tag,str(context)],timeout=600)
        item = self.image(tag)
        require(item["Config"]["Labels"].get(LABEL) == self.token,
                "built image ownership mismatch")
        self.images[tag] = item["Id"]
        return tag,item["Id"]

    def run_case(self):
        if self.case in ("phase-image", "phase-input"):
            return phase_change(self)
        if self.case == "cache-collision":
            return cache_collision(self)
        if self.case == "cache-file":
            return cache_collision(self, ("file",))
        if self.case == "non-git-default":
            a = self.project("non-git", git=False)
            explicit = self.capture(["bash", str(a / "scripts/sandbox-test.sh"),
                                     "--workspace-root", str(a), "true"], okay=False)
            require(explicit.returncode == 2 and
                    "trusted wrapper repository" in explicit.stderr,
                    "explicit non-Git workspace bypassed the admission trust check")
            job = self.start(a, "ordinary-default", runtime=False)
            self.finish(job)
            require(self.ack(job)["imports"] == 1 and self.installs(a) == 1,
                    "ordinary non-Git two-phase invocation did not import dependencies")
            return
        if self.case == "standard-builder":
            return standard_builder(self)
        if self.case == "admission":
            return admission(self)
        if self.case == "inputs-during-prepare":
            return inputs_during_prepare(self)
        if self.case == "node-linker-input":
            return node_linker_input(self)
        a = self.project("a")
        if self.case == "singleflight":
            self.control(a,"mode","hold")
            first = self.start(a,"cold-first")
            wait_for(lambda: (a/"controls/install.entered").exists(),[first])
            one = wait_for(lambda: self.observe(first),[first])
            second = self.start(a,"cold-second")
            two = wait_for(lambda: self.observe(second),[first,second])
            require(self.root_volume(one) == self.root_volume(two),
                    "same inputs did not select the same preparation tree")
            # This is exclusively a preparation probe, not a consumer lease.
            result = self.direct_run(self.args.image,
                ["--read-only","--entrypoint","bash",
                 "-v",self.root_volume(one)+":/modules:ro"],
                ["-c","exec 9</modules; flock --exclusive --nonblock 9"],
                okay=False)
            require(result.returncode == 1, "cold preparation is not exclusive")
            self.control(a,"install.release")
            self.finish(first); self.finish(second)
            require(self.installs(a) == 1, "same-key cold setup installed twice")
        elif self.case in ("coherence","legacy"):
            first = self.start(a,"first",watch=True); self.entered(first)
            second = self.start(a,"second",watch=True); self.entered(second)
            self.round(first,1); self.round(second,1)
            if self.case == "coherence":
                b = self.project("b","B")
                other = self.start(b,"different",watch=True)
                other_item = self.entered(other)
                self.round(first,2); self.round(second,2); self.round(other,1)
                require(self.root_volume(self.observe(first)) !=
                        self.root_volume(other_item),
                        "different inputs replaced the active dependency tree")
                self.release(other)
            else:
                # Deliberately noncooperative legacy mutator; only our three
                # old, private namespace volumes are writable.
                mounts = []
                for kind in ("node-modules","sidecar-node-modules","mcp-node-modules"):
                    mounts += ["-v",self.prefix+"-"+kind+":/legacy/"+kind]
                self.direct_run(self.args.image,
                    ["--read-only","--entrypoint","bash",*mounts],
                    ["-ec","for d in /legacy/*; do touch \"$d/legacy-marker\"; "
                     "find \"$d\" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; "
                     "test ! -e \"$d/legacy-marker\"; done"])
                self.round(first,2); self.round(second,2)
            self.release(first); self.release(second)
        elif self.case == "readonly":
            job = self.start(a,"tooling",command="pnpm exec fixture-cache-tool")
            self.finish(job)
            require(self.installs(a) == 1, "tooling unexpectedly reinstalled")
        elif self.case == "reuse":
            base = self.image(self.args.image)
            foundation = base["Config"]["Labels"].get(FOUNDATION)
            require(re.fullmatch(r"sha256:[0-9a-f]{64}",foundation or ""),
                    "candidate has no real exported foundation identity")
            require(self.image(foundation)["Id"] == foundation,
                    "exported foundation image is absent")
            initial = self.start(a,"initial",watch=True)
            original = self.root_volume(self.entered(initial))
            original_state = self.ack(initial)["state"]
            write(a/"ordinary-application-source.txt","changed source only")
            source = self.start(a,"source")
            self.finish(source)
            workload,_ = self.build("workload",
                "FROM "+self.args.image+"\nRUN printf workload-only > /workload-marker\n")
            require(self.image(workload)["Id"] != base["Id"] and
                    self.image(workload)["Config"]["Labels"][FOUNDATION] == foundation,
                    "workload derivative did not preserve its real foundation")
            image_job = self.start(a,"workload",image=workload)
            self.finish(image_job)
            require(self.ack(source)["state"] == original_state and
                    self.ack(image_job)["state"] == original_state and
                    self.installs(a) == 1,
                    "source/workload-only changes reinstalled dependencies")
            changed_tag,changed = self.build("foundation","FROM freshell-sandbox:dependency-foundation-v2-"+foundation.removeprefix("sha256:")+"\n"
                "RUN ln -s /usr/local/bin/node /usr/local/bin/freshell-fixture-node\n")
            require(changed != foundation,"foundation content did not change")
            runtime,_ = self.build("foundation-runtime",
                "FROM "+self.args.image+" AS candidate\nFROM "+changed_tag+"\n"
                "COPY --from=candidate /usr/local/share/freshell-sandbox "
                "/usr/local/share/freshell-sandbox\n"
                "COPY --from=candidate /usr/local/bin/sandbox-entrypoint.sh "
                "/usr/local/bin/sandbox-entrypoint.sh\n"
                "RUN printf '%s' '"+changed+"' > "
                "/usr/local/share/freshell-sandbox/foundation-id\n"
                "LABEL "+PROTOCOL+"=\"2\" "+FOUNDATION+"=\""+changed+"\"\n"
                "WORKDIR /workspace\n"
                "ENTRYPOINT [\"/usr/local/bin/sandbox-entrypoint.sh\"]\n")
            new = self.start(a,"foundation",image=runtime,watch=True,
                command="freshell-fixture-node scripts/reader.cjs foundation A watch")
            require(self.root_volume(self.entered(new)) != original and
                    self.ack(new)["key"] != self.ack(initial)["key"] and
                    self.installs(a) == 2,
                    "real foundation change did not prepare a separate tree")
            self.round(initial,1); self.round(new,1)
            self.release(new); self.release(initial)
        else:
            self.control(a,"mode","fail" if self.case == "failure" else "hold")
            failed = self.start(a,"blocked")
            wait_for(lambda: (a/"controls/install.entered").exists(),[failed])
            item = wait_for(lambda: self.observe(failed),[failed])
            volume = self.root_volume(item)
            self.state_absent(volume)
            if self.case == "failure":
                self.control(a,"install.release")
                self.finish(failed,expected=None)
            else:
                self.terminate(failed)
                self.finish(failed,expected=143)
            require(not (a/"controls/blocked.entered").exists(),
                    "caller ran after unsuccessful preparation")
            self.state_absent(volume)
            self.control(a,"mode","pass")
            recovered = self.start(a,"recovered")
            self.finish(recovered)
            require(self.installs(a) == 2 and self.ack(recovered)["key"],
                    "incomplete preparation was not retried successfully")

    def cleanup_standard_foundations(self):
        foundation_cleanup = []
        for tag, owned in self.standard_foundations.items():
            item = self.image(tag)
            require(item["Id"] == owned["id"],
                    "test foundation tag identity changed")
            consumers = self.capture(["docker", "ps", "-aq", "--filter",
                                      "ancestor=" + item["Id"]]).splitlines()
            ids = sorted(set(self.capture(["docker", "image", "ls", "-aq",
                                            "--no-trunc"]).splitlines()))
            layers = self.capture(["docker", "image", "inspect", "--format",
                                   "{{json .RootFS.Layers}}", *ids]).splitlines()
            own_layers = item["RootFS"]["Layers"]
            descendants = [image for image, raw in zip(ids, layers)
                           if image != item["Id"] and own_layers and
                           json.loads(raw)[:len(own_layers)] == own_layers]
            unreferenced = (item.get("RepoTags") == owned["tags"] and
                            item.get("RepoDigests") == owned["digests"] and
                            not consumers and not descendants)
            record = dict(owned, tag=tag, consumers=consumers,
                          descendants=descendants,
                          currentTags=item.get("RepoTags"),
                          currentDigests=item.get("RepoDigests"), removed=False)
            if unreferenced:
                self.capture(["docker", "image", "rm", tag])
                record["removed"] = True
            foundation_cleanup.append(record)
        write(self.results / "foundation-cleanup.json",
              json.dumps(foundation_cleanup), 0o600)

    def cleanup(self):
        errors = []
        for project in self.projects:
            self.control(project,"install.release")
            for job in self.jobs:
                if job["project"] == project:
                    self.control(project,job["name"]+".release")
        for job in self.jobs:
            try:
                if job["process"].poll() is None:
                    self.observe(job)
                    self.terminate(job)
                job["process"].wait(timeout=180)
                require(not list(job["control"].glob("freshell-sandbox-*")),
                        "owner guard did not settle")
            except Exception as error:
                errors.append(type(error).__name__)
            finally:
                job["stream"].close()
        # Existing wrapper/owner guards own teardown. On unsettled state,
        # retain its controls and caches; never invent a broad fallback kill.
        for cid,(name,project) in self.containers.items():
            found = self.capture(["docker","container","inspect",cid],okay=False)
            if found.returncode == 0:
                item=json.loads(found.stdout)[0]
                require(item["Name"] == "/"+name and any(
                    m["Destination"] == "/workspace" and m["Source"] == project
                    for m in item["Mounts"]),"recorded container ownership changed")
                errors.append("UnsettledWrapperContainer")
        for name in self.direct:
            found=self.capture(["docker","container","inspect",name],okay=False)
            if found.returncode == 0:
                item=json.loads(found.stdout)[0]
                require(item["Name"] == "/"+name and
                        item["Config"]["Labels"].get(LABEL) == self.token,
                        "helper ownership changed")
                self.capture(["docker","stop","--time","5",item["Id"]])
                self.capture(["docker","wait",item["Id"]],okay=False)
                require(not self.capture(["docker","ps","-aq","--no-trunc",
                        "--filter","name=^/"+name+"$"]).strip(),
                        "owned helper did not settle")
        volumes = self.capture(["docker","volume","ls","--format","{{.Name}}",
                               "--filter","name=^"+self.prefix+"-"]).splitlines()
        for volume,digest in self.targets.items():
            found=self.capture(["docker","volume","inspect",volume],okay=False)
            if found.returncode == 0:
                item=json.loads(found.stdout)[0]
                labels=item["Labels"] or {}
                require(labels.get("com.freshell.cache.owner") == "freshell" and
                        labels.get("com.freshell.cache.purpose") == "rust-target" and
                        labels.get("com.freshell.cache.worktree-sha256") == digest,
                        "fixture target ownership changed")
                volumes.append(volume)
        if not errors:
            for volume in volumes:
                require(not self.capture(["docker","ps","-aq","--filter",
                        "volume="+volume]).strip(),"owned volume is still referenced")
                self.capture(["docker","volume","rm",volume])
            for tag,expected in reversed(list(self.images.items())):
                found=self.capture(["docker","image","inspect",tag],okay=False)
                if found.returncode == 0:
                    item=json.loads(found.stdout)[0]
                    require((item["Config"]["Labels"].get(LABEL) == self.token or
                             (tag in self.standard_images and expected is not None)) and
                            (expected is None or item["Id"] == expected),
                            "task image ownership changed")
                    self.capture(["docker","image","rm",tag])  # Exact tag, no prune.
            self.cleanup_standard_foundations()
            # Retain the small synthetic inputs, never mounted dependency or
            # target data, before removing this fixture's host files.
            with tarfile.open(self.results / "fixture-inputs.tar.gz", "w:gz") as archive:
                for file in self.root.rglob("*"):
                    relative = file.relative_to(self.root)
                    if file.is_file() and not any(part in ("node_modules", "target", ".git")
                                                  for part in relative.parts):
                        archive.add(file, arcname=str(relative), recursive=False)
            shutil.rmtree(self.root)
        write(self.results/"cleanup.json",json.dumps({
            "wrappersJoined":all(j["process"].poll() is not None for j in self.jobs),
            "commands":self.command_count,"volumes":volumes,
            "errors":errors,"temporaryRootRetained":self.root.exists()}),0o600)
        require(not errors,"owned settlement failed; retain private evidence")


def phase_change(f):
    """Mutate the real tag or inputs after preparation's real Docker run."""
    a = f.project("phases")
    mutable, original = f.build("phase-tag", "FROM " + f.args.image + "\n")
    replacement, replacement_id = f.build("phase-replacement",
        "FROM " + f.args.image + "\nENV FRESHELL_PHASE_REVISION=changed\n")
    bin_dir = f.root / "phase-bin"
    bin_dir.mkdir()
    # This is a transparent real-Docker boundary hook, not a fake daemon. It
    # changes only task-owned fixture inputs/tag after the preparation exits.
    write(bin_dir / "docker", PHASE_DOCKER, 0o755)
    command = "test -z \"${FRESHELL_PHASE_REVISION:-}\" && " + shlex.join(
        ["node", "scripts/reader.cjs", "phases", "A", "once"])
    job = f.start(a, "phases", image=mutable, command=command,
                  extra_env={"PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                             "FIXTURE_REAL_DOCKER": shutil.which("docker"),
                             "FIXTURE_PHASE_PROJECT": str(a),
                             "FIXTURE_PHASE_CHANGE": f.case,
                             "FIXTURE_REPLACEMENT_IMAGE": replacement,
                             "FIXTURE_MUTABLE_IMAGE": mutable})
    if f.case == "phase-image":
        f.images[mutable] = replacement_id  # The exact test-owned boundary retag.
        f.finish(job)
        require(f.ack(job)["imports"] == 1 and f.installs(a) == 1,
                "tag change disrupted the selected image's actual import")
    else:
        f.finish(job, expected=2)
        log = (f.results / "phases.log").read_text()
        require('"event":"sandbox_dependency_inputs_changed"' in log,
                "input change did not produce the typed coherence refusal")
        require(not (a / "controls/phases.entered").exists(),
                "changed-input caller was admitted")
        volumes = f.capture(["docker", "volume", "ls", "--format", "{{.Name}}",
                             "--filter", "name=^" + f.prefix + "-dependencies-"]).splitlines()
        require(len(volumes) == 3, "input change created unprepared execution volumes")
    records = [json.loads(line) for line in
               (a / "controls/phases.jsonl").read_text().splitlines()]
    require(len(records) == (2 if f.case == "phase-image" else 1) and
            all(record["image"] == original for record in records),
            "one invocation executed different selected image identities")
    write(f.results / "phase-boundary.json", json.dumps(records), 0o600)


def cache_collision(f, kinds=("directory", "file")):
    """Actual installer lifecycle output cannot silently nest cache links."""
    for kind in kinds:
        a = f.project("collision-" + kind)
        manifest = json.loads((a / "package.json").read_text())
        manifest["scripts"]["postinstall"] = "node scripts/collision.cjs"
        write(a / "package.json", json.dumps(manifest))
        write(a / "scripts/collision.cjs", "const fs=require('node:fs');" +
              ("fs.mkdirSync('node_modules/.cache',{recursive:true});"
               if kind == "directory" else
               "fs.writeFileSync('node_modules/.cache','installer-owned');"))
        job = f.start(a, "collision-" + kind)
        f.finish(job, expected=2)
        require('"event":"sandbox_dependency_cache_collision"' in
                (f.results / ("collision-" + kind + ".log")).read_text(),
                "installer cache collision did not clearly refuse preparation")
        foundation = f.image(f.args.image)["Config"]["Labels"][FOUNDATION]
        version = f.image(f.args.image)["Config"]["Labels"][PROTOCOL]
        key = f.capture(["node", str(a / "docker/sandbox/dependency-cache.mjs"),
                         "--key", str(a), foundation, version]).strip()
        volume = f.prefix + "-dependencies-v2-" + key + "-node-modules"
        f.state_absent(volume)
        probe = "test -d /modules/.cache && test ! -L /modules/.cache/.cache" if kind == "directory" else "test \"$(cat /modules/.cache)\" = installer-owned"
        f.direct_run(f.args.image,
            ["--read-only", "--entrypoint", "bash", "-v", volume + ":/modules:ro"],
            ["-ec", probe])
        require(f.installs(a) == 1 and not (a / "controls" /
                ("collision-" + kind + ".entered")).exists(),
                "collision admitted a caller or installed more than once")


def standard_builder(f):
    """Run the production builder: workload changes reuse actual prepared trees."""
    a = f.project("builder")
    for relative in ("scripts/sandbox-build.sh", "docker/sandbox/Dockerfile",
                     "docker/sandbox/entrypoint.sh"):
        shutil.copyfile(REPO / relative, a / relative)
        (a / relative).chmod((REPO / relative).stat().st_mode & 0o777)
    original = (a / "docker/sandbox/Dockerfile").read_text()
    # Content in the real foundation stage, not an inherited runtime label.
    boundary = "FROM ${FRESHELL_SANDBOX_FOUNDATION_IMAGE} AS sandbox-runtime"
    require(boundary in original, "real foundation/runtime boundary missing")
    identities = []

    def build_and_import(name):
        tag = "freshell-sandbox:deptest-" + f.token + "-" + name
        require(f.capture(["docker", "image", "inspect", tag], okay=False)
                .returncode != 0, "task image already existed")
        env = os.environ.copy()
        env.update(FRESHELL_SANDBOX_IMAGE=tag, TMPDIR=str(f.root))
        before = [json.loads(line) for line in f.capture([
            "docker", "image", "ls", "-a", "--no-trunc", "--format",
            "{{json .}}"]).splitlines()]
        f.standard_images.add(tag)
        f.capture(["bash", str(a / "scripts/sandbox-build.sh")],
                  env=env, timeout=600)
        item = f.image(tag)
        # The standard builder sets no test ownership label. Record the exact
        # ID immediately; cleanup checks that ID before removing only our tag.
        f.images[tag] = item["Id"]
        foundation_id = item["Config"]["Labels"][FOUNDATION]
        foundation_tag = ("freshell-sandbox:dependency-foundation-v2-" +
                          foundation_id.removeprefix("sha256:"))
        foundation = f.image(foundation_tag)
        require(foundation["Id"] == foundation_id,
                "standard builder foundation tag identity differs")
        tag_absent = all(row["Repository"] + ":" + row["Tag"] !=
                         foundation_tag for row in before)
        id_absent = all(row["ID"] != foundation_id for row in before)
        if tag_absent and id_absent:
            require(foundation.get("RepoTags") == [foundation_tag],
                    "new test foundation already has other references")
            f.standard_foundations[foundation_tag] = dict(
                id=foundation_id, tags=foundation["RepoTags"],
                digests=foundation.get("RepoDigests"),
                priorTagAbsent=True, priorImageAbsent=True)
        write(f.results / "foundation-ownership.json", json.dumps({
            "owned": f.standard_foundations,
            "lastObserved": dict(tag=foundation_tag, id=foundation_id,
                                 priorTagAbsent=tag_absent,
                                 priorImageAbsent=id_absent)}), 0o600)
        job = f.start(a, name, image=tag)
        f.finish(job)
        ack = f.ack(job)
        require(ack["imports"] == 1, "actual prepared dependency import missing")
        identities.append({"image": item["Id"],
                           "foundation": item["Config"]["Labels"][FOUNDATION],
                           "key": ack["key"], "installs": f.installs(a)})
        write(f.results / "builder-identities.json", json.dumps(identities), 0o600)
        return identities[-1]

    first = build_and_import("builder-first")
    with (a / "docker/sandbox/entrypoint.sh").open("a") as source:
        source.write("\n# Test fixture workload-only revision.\n")
    second = build_and_import("builder-workload")
    require(first["foundation"] == second["foundation"],
            "standard builder changed foundation for a workload-only edit")
    require(first["key"] == second["key"] and second["installs"] == 1,
            "standard builder reinstalled unchanged dependencies")
    write(a / "docker/sandbox/Dockerfile", original.replace(boundary,
          'RUN printf "fixture-toolchain-revision-' + f.token + '\\n" > /usr/local/share/freshell-foundation-revision\n' + boundary))
    third = build_and_import("builder-foundation")
    require(third["foundation"] != first["foundation"] and
            third["key"] != first["key"] and third["installs"] == 2,
            "actual foundation content change reused the old prepared tree")


def inputs_during_prepare(f):
    """An input change during installation cannot publish the old-key tree."""
    a = f.project("changing")
    f.control(a, "mode", "hold")
    blocked = f.start(a, "changing-input")
    wait_for(lambda: (a / "controls/install.entered").exists(), [blocked])
    item = wait_for(lambda: f.observe(blocked), [blocked])
    old_volume = f.root_volume(item)
    require(f.installs(a) == 1, "the real first installer did not enter")
    f.state_absent(old_volume)
    waiter = f.start(a, "waiting-input")
    wait_for(lambda: f.observe(waiter), [blocked, waiter])
    wait_for(lambda: '"event":"sandbox_dependency_preparation_waiting"' in
             (f.results / "waiting-input.log").read_text(), [blocked, waiter])

    # This is actual dependency content, read by normal frozen installation.
    # The installer already owns preparation and is held in its real lifecycle.
    write(a / "marker/index.cjs", 'module.exports="B"')
    f.control(a, "install.release")
    f.finish(blocked, expected=None)
    f.finish(waiter, expected=None)
    require(not (a / "controls/waiting-input.entered").exists(),
            "waiting caller ran after inputs changed")
    require(not (a / "controls/changing-input.entered").exists(),
            "caller ran after its preparation inputs changed")
    f.state_absent(old_volume)

    # The default wrapper must independently select and prepare the new key.
    f.control(a, "mode", "pass")
    recovered = f.start(a, "changed-recovery", watch=True)
    recovered_item = f.entered(recovered)  # Real fresh Node import expects B.
    require(f.root_volume(recovered_item) != old_volume,
            "changed dependency bytes reused the abandoned old-key tree")
    require(f.installs(a) == 2 and f.ack(recovered)["key"],
            "new-input recovery did not execute exactly one additional install")
    f.round(recovered, 1)
    f.release(recovered)
    f.state_absent(old_volume)


def node_linker_input(f):
    """Real pnpm configuration changes installation; unchanged config reuses it."""
    a = f.project("linker")
    # Both layouts use the same manifest, lock, package bytes and foundation.
    # Observe the installed package link/directory and execute a fresh import;
    # reading .npmrc alone would not protect the behavior.
    write(a / "scripts/assert-linker.cjs", r"""
const fs = require('node:fs'), assert = require('node:assert/strict');
require('node:child_process').execFileSync(process.execPath, ['-e',
  "require('node:assert/strict').equal(require('sandbox-marker'),'A')"],
  {cwd:process.cwd(),stdio:'pipe',timeout:10000});
const installed = fs.lstatSync('node_modules/sandbox-marker');
assert.equal(installed.isSymbolicLink(), process.argv[2] === 'isolated');
assert.equal(installed.isDirectory(), process.argv[2] === 'hoisted');
""")

    def command(linker, name, watch=False):
        return (shlex.join(["node", "scripts/assert-linker.cjs", linker]) +
                " && " + shlex.join(["node", "scripts/reader.cjs", name, "A",
                                    "watch" if watch else "once"]))

    write(a / ".npmrc", "node-linker=isolated\n")
    isolated = f.start(a, "isolated", watch=True,
                       command=command("isolated", "isolated", True))
    isolated_volume = f.root_volume(f.entered(isolated))
    isolated_state = f.ack(isolated)["state"]
    require(f.installs(a) == 1, "initial linker setup did not install once")

    write(a / ".npmrc", "node-linker=hoisted\n")
    hoisted = f.start(a, "hoisted", watch=True,
                      command=command("hoisted", "hoisted", True))
    hoisted_volume = f.root_volume(f.entered(hoisted))
    # Imports succeed before the identity assertions, so RED demonstrates
    # either an actual wrong layout or wrong reuse, not an unused selector.
    f.round(isolated, 1)
    f.round(hoisted, 1)
    require(hoisted_volume != isolated_volume and
            f.ack(hoisted)["key"] != f.ack(isolated)["key"],
            "node-linker configuration reused the previous prepared identity")
    require(f.installs(a) == 2,
            "changed linker configuration did not execute one new install")
    require(f.ack(isolated)["state"] == isolated_state,
            "new linker preparation mutated the active isolated tree")

    warm = f.start(a, "hoisted-warm", command=command("hoisted", "hoisted-warm"))
    f.finish(warm)
    require(f.installs(a) == 2 and
            f.ack(warm)["state"] == f.ack(hoisted)["state"],
            "unchanged linker configuration reinstalled instead of reusing")
    f.round(isolated, 2)
    f.round(hoisted, 2)
    f.release(hoisted)
    f.release(isolated)

def admission(f):
    a = f.project("admission")
    positive = f.start(a, "positive", watch=True)
    item = f.entered(positive)  # Default preparation plus actual fresh import A.
    original_state = f.ack(positive)["state"]
    prepared_key = f.ack(positive)["key"]
    require(prepared_key, "positive preparation did not publish cache identity")
    candidate = f.image(f.args.image)
    candidate_id = candidate["Id"]
    version = candidate["Config"]["Labels"][PROTOCOL]
    foundation_id = candidate["Config"]["Labels"][FOUNDATION]
    foundation_tag = ("freshell-sandbox:dependency-foundation-v2-" +
                      foundation_id.removeprefix("sha256:"))
    require(f.image(foundation_tag)["Id"] == foundation_id,
            "retained content-addressed foundation tag disagrees with candidate")
    require(not f.args.image.startswith("sha256:"),
            "supply the existing task candidate tag, not a bare FROM image ID")

    def side_effect(name):
        return shlex.join(["node", "-e",
            "require('node:fs').writeFileSync(" +
            json.dumps("controls/" + name + ".called") + ",'unexpected')"])

    def forbidden(name):
        require(not (a / "controls" / (name + ".called")).exists(),
                "refused admission executed its caller")

    # Change real image configuration on private labeled image derivatives.
    # The unsupported image retains the candidate's actual entrypoint and
    # foundation. The missing-foundation image derives from the real exported
    # foundation, where the runtime foundation label is genuinely absent.
    unsupported, _ = f.build("unsupported-protocol",
        "FROM " + f.args.image + "\nLABEL " + PROTOCOL + "=\"0\"\n")
    missing, _ = f.build("missing-foundation",
        "FROM " + foundation_tag + "\nLABEL " + PROTOCOL +
        "=\"" + version + "\"\n")
    require(f.image(f.args.image)["Id"] == candidate_id,
            "candidate tag moved during derivative preparation")
    require(f.image(unsupported)["Config"]["Labels"][PROTOCOL] != version,
            "unsupported image did not change actual protocol metadata")
    require(not f.image(missing)["Config"]["Labels"].get(FOUNDATION),
            "missing-foundation derivative still has runtime foundation metadata")

    for name, image in (("unsupported", unsupported), ("no-foundation", missing)):
        refused = f.start(a, name, image=image, command=side_effect(name))
        f.finish(refused, expected=2)
        forbidden(name)
        f.round(positive, 1 if name == "unsupported" else 2)
        require(f.installs(a) == 1, "metadata refusal launched an installation")

    # Match normal runtime mount locations. Reuse only this fixture's existing
    # writable auxiliary caches and target; substitute three NEW empty module
    # volumes. No finished module tree is mounted writable or modified.
    empty = {slot: f.prefix + "-admission-empty-" + slot
             for slot in ("root", "sidecar", "mcp")}
    root_target = next(m["Name"] for m in item["Mounts"]
                       if m["Destination"] == "/workspace/target")
    mounts = [
        "-v", str(a) + ":/workspace",
        "-v", f.prefix + "-cargo-registry:/usr/local/cargo/registry",
        "-v", f.prefix + "-cargo-git:/usr/local/cargo/git",
        "-v", f.prefix + "-pnpm-store:/home/sandbox/.local/share/pnpm/store",
        "-v", root_target + ":/workspace/target",
        "-v", empty["root"] + ":/workspace/node_modules:ro",
        "-v", empty["sidecar"] +
              ":/workspace/crates/freshell-claude-sidecar/node_modules:ro",
        "-v", empty["mcp"] +
              ":/workspace/packages/freshell-mcp-runtime/node_modules:ro",
        "-v", f.prefix + "-playwright-cache:/home/sandbox/.cache/ms-playwright",
    ]

    def readonly_probe(name, module_mounts, expected):
        # Invoke the actual entrypoint; --entrypoint node would bypass the
        # admission behavior this case protects. Auxiliary cache ownership
        # needs the same CHOWN capability as the standard root initializer.
        result = f.direct_run(f.args.image,
            ["--read-only", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "DAC_OVERRIDE",
             "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
             "--tmpfs", "/home/sandbox/.cache:rw,nosuid,nodev,size=256m",
             "--entrypoint", "/usr/local/bin/sandbox-entrypoint.sh",
             "-e", "FRESHELL_SANDBOX_MODE=runtime-suite",
             "-e", "FRESHELL_SANDBOX_DEPENDENCY_READONLY=1",
             "-e", "FRESHELL_SANDBOX_DEPENDENCY_KEY=" + prepared_key,
             *module_mounts], shlex.split(side_effect(name)), okay=False)
        require(result.returncode == expected,
                "actual entrypoint returned an unexpected admission result")
        if expected:
            require('"event":"sandbox_dependency_not_prepared"' in result.stderr,
                    "denial did not reach the actual readiness guard")
            forbidden(name)
        else:
            require((a / "controls" / (name + ".called")).exists(),
                    "positive direct entrypoint caller did not run")

    prepared_mounts = mounts.copy()
    for mount in item["Mounts"]:
        if mount["Destination"] in ("/workspace/node_modules",
                "/workspace/crates/freshell-claude-sidecar/node_modules",
                "/workspace/packages/freshell-mcp-runtime/node_modules"):
            prepared_mounts[prepared_mounts.index(next(value for value in prepared_mounts
                if value.endswith(":" + mount["Destination"] + ":ro")))] = (
                mount["Name"] + ":" + mount["Destination"] + ":ro")
    readonly_probe("direct-positive", prepared_mounts, 0)
    readonly_probe("no-readiness", mounts, 2)

    # Deliberately incomplete readiness TEST DATA: the current fingerprint is
    # present, but cache_identity is absent. Copy only this small marker into
    # the private empty fixture, never dependencies or a completed tree.
    incomplete = "\n".join(line for line in original_state.splitlines()
                           if not line.startswith("cache_identity=")) + "\n"
    write(a / "controls/without-identity.state", incomplete)
    f.direct_run(f.args.image,
        ["--read-only", "--entrypoint", "bash",
         "-v", str(a) + ":/fixture:ro", "-v", empty["root"] + ":/empty"],
        ["-ec", "cp /fixture/controls/without-identity.state "
         "/empty/.sandbox-deps-state"])
    readonly_probe("no-cache-identity", mounts, 2)

    f.round(positive, 3)
    require(f.ack(positive)["state"] == original_state and f.installs(a) == 1,
            "admission probes changed completed preparation")
    f.release(positive)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--image",required=True)
    parser.add_argument("--results",required=True,type=Path)
    parser.add_argument("--temp-root",required=True,type=Path)
    parser.add_argument("--wrapper-source",type=Path,
                        default=REPO/"scripts/sandbox-test.sh")
    parser.add_argument("--identity-source",type=Path,
                        default=REPO/"docker/sandbox/dependency-cache.mjs")
    parser.add_argument("--case",action="append",choices=CASES+("all",))
    args=parser.parse_args()
    os.umask(0o077)
    args.results=args.results.resolve()
    args.temp_root=args.temp_root.resolve()
    args.wrapper_source=args.wrapper_source.resolve(strict=True)
    args.identity_source=args.identity_source.resolve(strict=True)
    require(args.results.is_relative_to(REPO/"test-results") and
            args.temp_root.is_relative_to(REPO/".test-tmp"),
            "results and temporary roots must stay in task worktree")
    require(str(REPO).startswith("/home/"),"test requires the /home filesystem")
    for path in (args.results,args.temp_root):
        path.mkdir(parents=True,exist_ok=True,mode=0o700)
        require(path.stat().st_mode & 0o077 == 0,"task parent is not private")
    selected=CASES if not args.case or "all" in args.case else tuple(dict.fromkeys(args.case))
    outcomes=[]
    for case in selected:
        fixture=None
        outcome=dict(case=case,status="FAIL")
        try:
            fixture=Fixture(args,case)
            fixture.run_case()
            outcome["status"]="PASS"
        except Exception as error:
            outcome["error"]=type(error).__name__  # Raw details stay private.
            if fixture is not None:
                write(fixture.results/"failure.txt",traceback.format_exc(),0o600)
        finally:
            if fixture is not None:
                try:
                    fixture.cleanup()
                except Exception as error:
                    outcome.update(status="FAIL",cleanupError=type(error).__name__)
                    write(fixture.results/"cleanup-failure.txt",
                          traceback.format_exc(),0o600)
        outcomes.append(outcome)
        print(json.dumps(outcome),flush=True)
        if outcome["status"] != "PASS":
            break
    write(args.results/("summary-"+uuid.uuid4().hex[:12]+".json"),
          json.dumps(outcomes),0o600)
    print(json.dumps({"passed":sum(r["status"]=="PASS" for r in outcomes),
                      "attempted":len(outcomes)}),flush=True)
    return 0 if len(outcomes)==len(selected) and all(
        r["status"]=="PASS" for r in outcomes) else 1


if __name__=="__main__":
    raise SystemExit(main())
