from pathlib import Path
import os,json,hashlib,shutil,subprocess,tempfile,datetime
root=Path('/home/dan/code/freshell')
base=Path('/home/dan/.local/state/freshell-updates')
base.mkdir(mode=0o700,parents=True,exist_ok=True)
packet=Path(tempfile.mkdtemp(prefix='prepare-20dbddf53-',dir=base))
os.chmod(packet,0o700)
prior=packet/'prior';prior.mkdir(mode=0o700)
units={}
for unit in ['freshell-rust.service','freshell-supervisor.service']:
 pid=int(subprocess.check_output(['systemctl','--user','show',unit,'-p','MainPID','--value'],text=True).strip())
 source=Path('/proc')/str(pid)/'exe'
 name='freshell-server' if unit=='freshell-rust.service' else 'freshell-supervisor'
 target=prior/name
 shutil.copyfile(source,target);os.chmod(target,0o700)
 units[unit]={'pid':pid,'cwd':str((Path('/proc')/str(pid)/'cwd').resolve()),'exeLink':os.readlink(source),'priorArtifact':str(target),'sha256':hashlib.file_digest(target.open('rb'),'sha256').hexdigest()}
source=root/'target/release/freshell-session-host';target=prior/'freshell-session-host'
shutil.copyfile(source,target);os.chmod(target,0o700)
host={'path':str(source),'priorArtifact':str(target),'sha256':hashlib.file_digest(target.open('rb'),'sha256').hexdigest()}
shutil.copytree(root/'dist/client',prior/'client')
commit=subprocess.check_output(['git','rev-parse','origin/main'],cwd=root,text=True).strip()
record={'preparedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidateCommit':commit,'packet':str(packet),'units':units,'installedSessionHost':host,'status':'preparing; live services and stores unchanged'}
file=packet/'preparation.json';file.write_text(json.dumps(record,indent=2));os.chmod(file,0o600)
print(json.dumps(record,indent=2))
