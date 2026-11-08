"""Executable transport behavior checks; no compiler or daemon invocation."""
import copy
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
sys.dont_write_bytecode=True
import cargo_route
import transport_route as route
from compiler_route import Refusal

D=Path(__file__).resolve().parent
CFG=json.loads((D/'route.json').read_text())

def arguments():
    name='freshell-sandbox-Ab123456'
    args=['run','--rm','--init','--name',name,'--cidfile','/tmp/'+name+'/container.id',
        '--network','none','--pids-limit','512','--memory','8g','-v',CFG['checkout']+':/workspace',
        '--read-only','--security-opt','no-new-privileges','-e','FRESHELL_SANDBOX_MODE=runtime-suite']
    for dst in ['/workspace/target','/freshell-test-artifacts']:
        args+=['--mount',','.join(['type=volume','src='+CFG['cacheVolume'],'dst='+dst,
            *['volume-label='+k+'='+v for k,v in route.labels(CFG).items()]])]
    return [*args,CFG['sandboxImageTag'],'bash','-c',"export CARGO_TARGET_DIR='/freshell-test-artifacts/targets/46620d7db107'\ncargo test --workspace --locked\n"]

class TransportTests(unittest.TestCase):
    def test_exact_volume_metadata_only(self):
        volume=CFG['cacheVolume']
        for args in [['volume','ls','--format','{{.Name}}','--filter','name='+volume],
                     ['volume','inspect','--format','{{json .Labels}}',volume]]:
            self.assertTrue(route.metadata_allowed(args,CFG))
            self.assertTrue(route.push_allowed(args,CFG))
        for args in [['volume','ls'],['volume','inspect',volume],['volume','rm',volume],
                     ['volume','create',volume],['volume','prune'],
                     ['volume','ls','--format','{{.Name}}','--filter','name=foreign'],
                     ['volume','inspect','--format','{{json .Labels}}','freshell-sandbox-cargo-target']]:
            self.assertFalse(route.push_allowed(args,CFG))

    def test_refuse_mutating_or_foreign_docker_commands(self):
        for args in [['build','.'],['pull','fixture'],['network','create','x'],['context','use','x'],['run','foreign']]:
            self.assertFalse(route.push_allowed(args,CFG))

    def test_both_exact_labeled_aliases_required(self):
        args=arguments()
        self.assertIsNotNone(route.cache_mounts(args,CFG))
        for old,new in [(CFG['cacheVolume'],'freshell-sandbox-cargo-target'),
                        ('volume-label=com.freshell.cache.schema=1','volume-label=com.freshell.cache.schema=2'),
                        ('dst=/workspace/target','dst=/workspace/other')]:
            changed=[x.replace(old,new) for x in args]
            with self.assertRaises(Refusal): route.cache_mounts(changed,CFG)

    def test_runtime_root_adjustment_changes_only_known_declaration(self):
        body=arguments()[-1]
        changed,selected=route.retarget(body,CFG)
        self.assertTrue(selected)
        self.assertEqual(changed,'export CARGO_TARGET_DIR=/freshell-test-artifacts\n'+body.split('\n',1)[1])
        self.assertEqual(route.retarget(changed,CFG),(changed,False))
        for body in [body+body,body.replace("'\n",'\n'),body+'echo /freshell-test-artifacts/targets/46620d7db107\n']:
            with self.assertRaises(Refusal): route.retarget(body,CFG)

    def test_compiler_selection_and_original_cargo_argv_preserved(self):
        args=arguments(); cfg=CFG
        ctx={'cwd':cfg['checkout'],'parentCwd':cfg['checkout'],
            'parentArguments':[b'bash',(cfg['checkout']+'/scripts/sandbox-test.sh').encode()],
            'parentUid':cfg['uid'],'uid':cfg['uid'],'directoryUid':cfg['uid'],'directoryMode':0o700,
            'directoryIsLink':False,'ownerName':'freshell-sandbox-Ab123456','cidNonempty':False,
            'contextEnvironment':cfg['contextEnvironment'],'cliDigest':cfg['realDockerCliSha256'],
            'dockerContext':cfg['dockerContext'],'dockerDaemonId':cfg['dockerDaemonId'],
            'sandboxImageId':cfg['sandboxImageId']}
        changed,event=route.prepare(args,cfg,ctx)
        self.assertTrue(changed[-1].endswith('cargo test --workspace --locked\n'))
        self.assertNotIn('CARGO_PROFILE_',changed[-1])
        self.assertTrue(event['runtimeTargetRootAdjusted'])
        self.assertEqual(changed[:len(args)-4],args[:len(args)-4])
        self.assertIn('RUSTUP_TOOLCHAIN=1.96.0',changed)
        self.assertEqual(event['cacheVolume'],cfg['cacheVolume'])

    def test_cargo_test_allowlist_is_unchanged_and_closed(self):
        for args in [['test','--workspace','--locked'],['test','--locked','-p','freshell-ws']]:
            cargo_route.validate_test(args)
        for args in [['test','--workspace'],['test','--workspace','--locked','--','--list'],
                     ['test','--locked','-p','freshell-ws','--features','other'],
                     ['test','--locked','-p','a;bad'],['test','--workspace','--locked','--no-run']]:
            with self.assertRaises(cargo_route.Refusal): cargo_route.validate_test(args)

    def test_controlled_shell_retains_build_test_argv_and_status(self):
        template='before\n'+cargo_route.MARKER+'\nafter\n'
        argv=['test','--locked','-p','freshell-ws','-p','freshell-core']
        line=cargo_route.replace_runner(template,argv).removeprefix('before\n').removesuffix('\nafter\n')
        words=shlex.split(line)
        with tempfile.TemporaryDirectory(dir=D) as directory:
            p=Path(directory)
            fake=p/'cargo'
            fake.write_text('#!'+sys.executable+'\nimport json,os,sys\nwith open(os.environ["CALLS"],"a") as f:f.write(json.dumps(sys.argv[1:])+"\\n")\nraise SystemExit(0 if sys.argv[1]=="build" else 37)\n')
            fake.chmod(0o755)
            import os
            calls=p/'calls'
            child=subprocess.run(words[:-1],env={**os.environ,'PATH':directory+':/usr/bin:/bin','CALLS':str(calls),'CARGO_TARGET_DIR':'/freshell-test-artifacts'},capture_output=True,text=True,timeout=10)
            self.assertEqual(child.returncode,37,child.stderr)
            self.assertEqual([json.loads(x) for x in calls.read_text().splitlines()],[['build','-p','freshell-server','--locked'],argv])

if __name__=='__main__': unittest.main(verbosity=2)
