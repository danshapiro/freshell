#!/usr/bin/env python3
"""Closed owned-volume qualification of the production mountpoint helper."""
import argparse
import hashlib
import json
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import uuid

IMAGE = "sha256:967627e41734aa903e824e4be22849c7f22ce0e69487ce61bb72004c4817f89c"
LABEL = "com.freshell.mountpoint-probe"

def docker(*args, check=True):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=60, check=check)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--receipt-dir", type=Path, required=True)
    args=parser.parse_args()
    binary=args.binary.resolve(strict=True)
    expected=Path(__file__).resolve().parents[2]/"target/debug/freshell-session-host"
    if binary != expected or not binary.is_file() or not args.receipt_dir.is_dir():
        raise RuntimeError("mountpoint fixture requires this worktree's compiled host and existing receipt directory")
    if "name=rootless" not in json.loads(docker("info","--format","{{json .SecurityOptions}}").stdout):
        raise RuntimeError("mountpoint fixture requires the qualified rootless daemon")
    if docker("image","inspect","--format","{{.Id}}",IMAGE).stdout.strip()!=IMAGE:
        raise RuntimeError("mountpoint fixture requires the exact cached provider image")
    run="freshell-mountpoint-probe-"+uuid.uuid4().hex
    volume=run+"-volume"
    owned=[]
    receipt={"image":IMAGE,"runId":run,"rootless":True,"binarySha256":hashlib.file_digest(binary.open("rb"),"sha256").hexdigest()}
    def remove(name):
        result=docker("container","inspect",name,check=False)
        if result.returncode:
            return
        actual=json.loads(result.stdout)[0]
        if actual["Config"].get("Labels",{}).get(LABEL)!=run:
            raise RuntimeError("mountpoint cleanup ownership changed")
        docker("rm","--force",actual["Id"])
    def create(name,*args):
        owned.append(name)
        docker("create","--name",name,"--label",f"{LABEL}={run}","--network","none","--read-only",
               "--cap-drop","ALL","--security-opt","no-new-privileges:true","--pids-limit","32","--memory","128m",*args)
    with tempfile.TemporaryDirectory(prefix=run) as temporary:
        exchange=Path(temporary)
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        listener.settimeout(20)
        listener.bind(str(exchange/"reply.sock"));listener.listen(1)
        try:
            setup=run+"-socket-mode"
            create(setup,"--mount",f"type=bind,src={exchange},dst=/exchange","--entrypoint","/bin/sh",IMAGE,
                   "-ceu","chmod 710 /exchange; chmod 660 /exchange/reply.sock")
            if docker("start","--attach",setup).returncode:
                raise RuntimeError("mountpoint socket setup failed")
            remove(setup)
            docker("volume","create","--label",f"{LABEL}={run}","--driver","local",volume)
            selected=[{"relativePath":".config/opencode/opencode.json","directory":False},
                      {"relativePath":".freshell/provider-roots/plugin-0","directory":True}]
            for attempt in range(2):
                helper=run+f"-helper-{attempt}"
                create(helper,"--user","0:0","--cap-add","CHOWN","--cap-add","SETGID","--cap-add","SETUID","--log-driver","none",
                       "--mount",f"type=bind,src={binary},dst=/runtime/freshell-session-host,readonly",
                       "--mount",f"type=volume,src={volume},dst=/home/freshell/provider,volume-nocopy",
                       "--mount",f"type=bind,src={exchange},dst=/run/freshell-input-exchange,readonly",
                       "--entrypoint","/runtime/freshell-session-host",IMAGE,"prepare-provider-mountpoints")
                docker("start",helper)
                stream,_=listener.accept();stream.settimeout(20)
                with stream:
                    frame=json.dumps(selected,separators=(",",":")).encode()
                    stream.sendall(struct.pack(">I",len(frame))+frame)
                    if stream.recv(2)!=b"ok":
                        raise RuntimeError("mountpoint helper failed its bounded acknowledgement")
                if docker("wait",helper).stdout.strip()!="0":
                    raise RuntimeError("mountpoint helper failed")
                remove(helper)
                consumer=run+f"-consumer-{attempt}"
                probe="""const fs=require('fs');const h='/home/freshell/provider',f=h+'/.config/opencode/opencode.json',r=h+'/.freshell/provider-roots/plugin-0';const s=fs.lstatSync(f),d=fs.lstatSync(r),hs=fs.lstatSync(h);if(!s.isFile()||s.isSymbolicLink()||!d.isDirectory()||s.uid!==65534||d.uid!==65534||hs.uid!==65534)throw Error('placeholder ownership');const text=fs.readFileSync(f,'utf8');if(process.argv[1]==='0'){if(text)throw Error('initial file');fs.writeFileSync(f,'retained-owned-nonce')}else if(text!=='retained-owned-nonce')throw Error('retained overwrite');console.log(JSON.stringify({inode:s.ino,rootInode:d.ino,homeInode:hs.ino,uid:process.getuid(),gid:process.getgid(),capEff:fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s*(\\w+)/m)[1]}));"""
                create(consumer,"--user","65534:0","--mount",f"type=volume,src={volume},dst=/home/freshell/provider,volume-nocopy",
                       "--entrypoint","/usr/local/bin/node",IMAGE,"-e",probe,str(attempt))
                actual=json.loads(docker("start","--attach",consumer).stdout)
                if actual["uid"]!=65534 or actual["gid"]!=0 or actual["capEff"]!="0000000000000000":
                    raise RuntimeError("mountpoint consumer identity changed")
                if attempt==0:
                    receipt["initial"]=actual
                elif actual!=receipt["initial"]:
                    raise RuntimeError("retained mountpoint or HOME inode changed")
                remove(consumer)
            receipt["retainedInodesAndBytesPreserved"]=True
        finally:
            listener.close()
            for name in reversed(owned):
                remove(name)
            result=docker("volume","inspect",volume,check=False)
            if result.returncode==0:
                actual=json.loads(result.stdout)[0]
                if actual.get("Labels",{}).get(LABEL)!=run:
                    raise RuntimeError("mountpoint volume cleanup ownership changed")
                docker("volume","rm",volume)
            receipt["ownedCleanup"]=all(docker("container","inspect",name,check=False).returncode!=0 for name in owned) and docker("volume","inspect",volume,check=False).returncode!=0
            (args.receipt_dir/"task002-native-provider-mountpoints.json").write_text(json.dumps(receipt,sort_keys=True)+"\n")
    print(json.dumps(receipt,sort_keys=True),flush=True)

if __name__=="__main__":
    main()
