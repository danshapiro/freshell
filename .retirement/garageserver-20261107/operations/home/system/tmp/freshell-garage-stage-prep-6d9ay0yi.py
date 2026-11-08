from pathlib import Path
import subprocess,json,os,hashlib,tarfile,datetime
source=Path('/home/dan/code/freshell/.worktrees/.base-gate-242209')
packet=Path('/home/dan/.local/state/freshell-updates/prepare-20dbddf53-6d9ay0yi')
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
assert commit=='20dbddf53d831c2fbcebdac294d67cc262c57838',commit
status=subprocess.check_output(['git','status','--porcelain=v1'],cwd=source,text=True)
assert not status,status
tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=source,text=True).strip()
archive=packet/'source.tar';snapshot=packet/'source';snapshot.mkdir(mode=0o700)
with archive.open('wb') as out:subprocess.run(['git','archive','--format=tar','HEAD'],cwd=source,stdout=out,check=True)
os.chmod(archive,0o600)
with tarfile.open(archive) as tar:tar.extractall(snapshot,filter='data')
for name in ['candidate','logs']:(packet/name).mkdir(mode=0o700)
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceWorktree':str(source),'commit':commit,'tree':tree,'cleanAtArchive':True,'archive':str(archive),'archiveSha256':hashlib.file_digest(archive.open('rb'),'sha256').hexdigest(),'preservedSource':str(snapshot)}
p=packet/'source-provenance.json';p.write_text(json.dumps(record,indent=2));os.chmod(p,0o600)
print(json.dumps(record,indent=2))
