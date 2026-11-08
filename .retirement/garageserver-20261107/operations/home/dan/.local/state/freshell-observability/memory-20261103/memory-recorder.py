#!/usr/bin/env python3
"""Bounded, read-only memory evidence for a self-hosted Freshell machine."""
import argparse,datetime,json,os,pathlib,subprocess,time,sys,shutil,socket,http.client
P=pathlib.Path
parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--once',action='store_true');parser.add_argument('--interval',type=float,default=5);args=parser.parse_args()
os.umask(0o077);output=P(args.output);output.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
root=P('/sys/fs/cgroup');uid=os.getuid();user=root/f'user.slice/user-{uid}.slice/user@{uid}.service';page=os.sysconf('SC_PAGE_SIZE')
max_bytes=8*1024*1024;backups=3;errors={}
stop_at=None
if not args.once:
 deadline_file=output.parent/'stop-at-epoch'
 try:
  with deadline_file.open('x') as f:f.write(str(time.time()+86340))
 except FileExistsError:pass
 stop_at=float(deadline_file.read_text())

def read(path):
 try:return P(path).read_text().strip()
 except (OSError,ValueError):return None

def number(path):
 value=read(path)
 try:return int(value) if value is not None else None
 except ValueError:return value

def pressure(path):
 value=read(path);result={}
 if value:
  for line in value.splitlines():
   fields=line.split();result[fields[0]]={k:float(v) if k!='total' else int(v) for k,v in (part.split('=',1) for part in fields[1:])}
 return result

def pairs(path):
 value=read(path);result={}
 if value:
  for line in value.splitlines():
   fields=line.split()
   if len(fields)==2:
    try:result[fields[0]]=int(fields[1])
    except ValueError:pass
 return result

def emit(event,**fields):
 row={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'monotonicSeconds':round(time.monotonic(),3),'severity':'info','event':event,**fields}
 raw=(json.dumps(row,separators=(',',':'))+'\n').encode()
 if output.exists() and output.stat().st_size+len(raw)>max_bytes:
  oldest=P(str(output)+'.'+str(backups));oldest.unlink(missing_ok=True)
  for index in range(backups-1,0,-1):
   source=P(str(output)+'.'+str(index))
   if source.exists():source.rename(P(str(output)+'.'+str(index+1)))
  output.rename(P(str(output)+'.1'))
 with output.open('ab',buffering=0) as f:f.write(raw);os.fdatasync(f.fileno())
 return row

def save_incident(reason):
 # Preserve the preceding log even after the rolling files rotate overnight.
 incident=output.parent/('incident-'+str(time.time_ns())+'.jsonl')
 shutil.copyfile(output,incident);os.chmod(incident,0o600)
 with incident.open('rb') as f:os.fsync(f.fileno())
 for old in sorted(output.parent.glob('incident-*.jsonl'))[:-3]:old.unlink()
 emit('memory.incident.saved',reason=reason,file=incident.name)

STAT_KEYS={'anon','file','kernel','shmem','file_mapped','file_dirty','file_writeback','slab','sock','pgscan','pgsteal','workingset_refault_anon','workingset_refault_file'}
def group(path):
 stats=pairs(path/'memory.stat')
 label='/' if path==root else '/'+str(path.relative_to(root))
 return {'path':label,'bytes':number(path/'memory.current'),'peakBytes':number(path/'memory.peak'),'swapBytes':number(path/'memory.swap.current'),'high':number(path/'memory.high'),'max':number(path/'memory.max'),'pressure':pressure(path/'memory.pressure'),'events':pairs(path/'memory.events'),'localEvents':pairs(path/'memory.events.local'),'stat':{k:v for k,v in stats.items() if k in STAT_KEYS},'pids':number(path/'pids.current')}

def cgroups():
 candidates=[];pressured=[]
 if user.exists():
  for parent,dirs,files in os.walk(user):
   path=P(parent);current=number(path/'memory.current')
   if isinstance(current,int):candidates.append((current,path))
   psi=pressure(path/'memory.pressure');level=max((v.get('avg10',0) for v in psi.values()),default=0)
   if level>0:pressured.append((level,path))
 selected={path for _,path in sorted(candidates,key=lambda x:x[0],reverse=True)[:24]}
 selected.update(path for _,path in sorted(pressured,key=lambda x:x[0],reverse=True)[:12])
 for path in [root,root/'user.slice',root/f'user.slice/user-{uid}.slice',user,user/'app.slice/freshell-rust.service',user/'app.slice/freshell-supervisor.service',user/'app.slice/docker.service']:
  if path.exists():selected.add(path)
 return [group(path) for path in sorted(selected)]

def processes():
 rows=[];totals={}
 for entry in P('/proc').iterdir():
  if not entry.name.isdigit():continue
  value=read(entry/'stat')
  if not value:continue
  try:
   end=value.rfind(')');comm=value[value.index('(')+1:end];fields=value[end+2:].split();rss=int(fields[21])*page
   cgroup=read(entry/'cgroup') or '';cg=next((line[3:] for line in cgroup.splitlines() if line.startswith('0::')),'unknown')
   total=totals.setdefault(cg,{'processes':0,'rssBytes':0});total['processes']+=1;total['rssBytes']+=rss
   rows.append({'pid':int(entry.name),'ppid':int(fields[1]),'comm':comm,'startTicks':int(fields[19]),'rssBytes':rss,'cpuTicks':int(fields[11])+int(fields[12]),'cgroup':cg})
  except (ValueError,IndexError,OSError):continue
 rows.sort(key=lambda x:x['rssBytes'],reverse=True)
 selected=rows[:40]
 for row in selected:
  try:row['exe']=os.readlink('/proc/'+str(row['pid'])+'/exe')
  except OSError:pass
  status=read('/proc/'+str(row['pid'])+'/status')
  if status:
   for line in status.splitlines():
    if line.startswith('VmSwap:'):row['swapBytes']=int(line.split()[1])*1024
 service_path='/'+str(user.relative_to(root))+'/app.slice/freshell-rust.service'
 servers=[{'pid':r['pid'],'startTicks':r['startTicks'],'rssBytes':r['rssBytes']} for r in rows if r['comm']=='freshell-server' and r['cgroup']==service_path]
 return selected,[{'path':path,**data} for path,data in sorted(totals.items(),key=lambda x:x[1]['rssBytes'],reverse=True)[:25]],len(rows),servers

def containers():
 # Unix HTTP avoids spawning a Docker CLI; archived metadata also works while the daemon is down.
 conn=None;sock=None;failure=None
 try:
  sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);sock.settimeout(2)
  sock.connect('/run/user/'+str(uid)+'/docker.sock')
  conn=http.client.HTTPConnection('localhost',timeout=2);conn.sock=sock
  conn.request('GET','/containers/json?all=1');response=conn.getresponse()
  if response.status!=200:raise OSError('Docker metadata unavailable')
  raw=response.read(4*1024*1024+1)
  if len(raw)>4*1024*1024:raise ValueError('Docker metadata exceeds bound')
  data=json.loads(raw)
  return {'source':'docker-unix-api','containers':[{'id':x['Id'],'name':','.join(x.get('Names',[])),'image':x.get('Image'),'worktreeSources':[m['Source'] for m in x.get('Mounts',[]) if '/.worktrees/' in m.get('Source','')]} for x in data[:500]]}
 except (OSError,ValueError,http.client.HTTPException) as exc:failure=type(exc).__name__
 finally:
  if conn is not None:conn.close()
  elif sock is not None:sock.close()
 rows=[]
 for path in sorted((P.home()/'.local/share/docker/containers').glob('*/config.v2.json'))[:500]:
  try:
   data=json.loads(path.read_text());mounts=(data.get('MountPoints') or {}).values()
   rows.append({'id':path.parent.name,'name':data.get('Name'),'image':(data.get('Config') or {}).get('Image'),'worktreeSources':[m['Source'] for m in mounts if '/.worktrees/' in m.get('Source','')]})
  except (OSError,ValueError):continue
 return {'source':'archived-docker-metadata-not-live-status','apiError':failure,'containers':rows}

def sample():
 mem={}
 for line in (read('/proc/meminfo') or '').splitlines():
  fields=line.split()
  if fields[0].rstrip(':') in {'MemTotal','MemAvailable','MemFree','Cached','SReclaimable','SwapTotal','SwapFree','AnonPages','Shmem','Dirty','Writeback'}:mem[fields[0].rstrip(':')]=int(fields[1])*1024
 top,rollups,count,servers=processes()
 return emit('memory.sample',hostMemoryBytes=mem,hostPressure=pressure('/proc/pressure/memory'),cgroups=cgroups(),largestProcesses=top,processGroupRss=rollups,processCount=count,freshellServers=servers)

emit('memory.recorder.started',pid=os.getpid(),uid=uid,intervalSeconds=args.interval,maximumLogBytes=64*1024*1024,stopAtEpoch=stop_at,commandLinesRecorded=False,conversationContentRecorded=False)
next_container=0;last_servers=None;last_incident=0
while True:
 if stop_at is not None and time.time()>=stop_at:
  emit('memory.recorder.finished',reason='24-hour-observation-complete');break
 started=time.monotonic()
 try:
  row=sample();servers=sorted((x['pid'],x['startTicks']) for x in row['freshellServers'])
  level=max((v.get('avg10',0) for g in row['cgroups'] for v in g['pressure'].values()),default=0)
  if last_servers is not None and servers!=last_servers:
   save_incident('freshell-server-process-changed');last_incident=started
  elif level>=25 and started-last_incident>=60:
   save_incident('cgroup-memory-pressure-at-least-25-percent');last_incident=started
  last_servers=servers
  if started>=next_container:emit('memory.container_map',**containers());next_container=started+60
 except Exception as exc:
  emit('memory.sample.error',errorType=type(exc).__name__)
 if args.once:break
 time.sleep(max(.1,args.interval-(time.monotonic()-started)))
