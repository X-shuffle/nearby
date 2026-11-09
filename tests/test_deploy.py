"""Exercise the deployment boundary without contacting Docker or deploying services."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['FAKE_LOG'], 'a') as f: f.write(json.dumps(args)+'\n')
if args[0:1] == ['info']: sys.exit(int(os.environ.get('FAKE_DAEMON_FAIL','0')))
if args[:1] != ['compose']: sys.exit(2)
if args[1:2] == ['version']:
 print(os.environ.get('FAKE_VERSION','2.39.3')); sys.exit(0)
if 'config' in args:
 if '--environment' in args:
  values={}
  for i,a in enumerate(args):
   if a=='--env-file':
    for line in pathlib.Path(args[i+1]).read_text().splitlines():
     if '=' in line and not line.startswith('#'):
      k,v=line.split('=',1);values[k.strip()]=v.strip().strip('"').strip("'")
  values.update({k:v for k,v in os.environ.items() if k in values})
  print('NEARBY_DOMAIN='+values.get('NEARBY_DOMAIN',''))
 sys.exit(0)
if 'up' in args: sys.exit(int(os.environ.get('FAKE_UP_FAIL','0')))
sys.exit(0)
'''
FAKE_CURL = r'''#!/usr/bin/env python3
import os, pathlib, sys
args=sys.argv[1:]
if os.environ.get('FAKE_CURL_FAIL'): sys.exit(22)
out=pathlib.Path(args[args.index('-o')+1])
if os.environ.get('FAKE_CURL_BAD'): out.write_text('<html>error</html>')
else: out.write_text('173.245.48.0/20\n' if any('ips-v4' in a for a in args) else '2400:cb00::/32\n')
'''

class DeployTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='nearby deploy ')
  self.root=Path(self.temp.name)
  for name in ('deploy.sh','.env.example','.env.cloudflare.example','compose.yaml'):
   shutil.copy2(ROOT/name,self.root/name)
  self.bin=self.root/'fakebin'; self.bin.mkdir()
  for name,content in [('docker',FAKE_DOCKER),('curl',FAKE_CURL)]:
   path=self.bin/name;path.write_text(content);path.chmod(0o755)
  self.log=self.root/'calls.jsonl'
  self.env={**os.environ,'PATH':str(self.bin)+os.pathsep+os.environ['PATH'],'FAKE_LOG':str(self.log)}
  for key in ('NEARBY_DOMAIN','CLOUDFLARE_TRUSTED_PROXIES','FAKE_UP_FAIL','FAKE_DAEMON_FAIL','FAKE_VERSION','FAKE_CURL_FAIL','FAKE_CURL_BAD'):
   self.env.pop(key,None)
 def tearDown(self): self.temp.cleanup()
 def run_script(self,*args,success=True):
  result=subprocess.run(['bash',str(self.root/'deploy.sh'),*args],cwd='/tmp',env=self.env,text=True,capture_output=True)
  if success:self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  else:self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
  return result
 def init(self): self.run_script('init','--domain','nearby.your-domain.com')
 def calls(self): return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
 def test_help_and_init_do_not_contact_docker(self):
  self.run_script('--help');self.init();self.assertEqual(self.calls(),[])
  self.assertEqual((self.root/'.env').stat().st_mode&0o777,0o600)
 def test_init_preserves_existing_settings_and_only_updates_domain(self):
  self.init();p=self.root/'.env';p.write_text(p.read_text()+'STUN_URLS=stun:my-server:3478\nCUSTOM=value\n')
  old=p.read_text();self.run_script('init');self.assertEqual(p.read_text(),old)
  self.run_script('init','--domain','other.your-domain.com');self.assertIn('CUSTOM=value',p.read_text());self.assertIn('STUN_URLS=stun:my-server:3478',p.read_text());self.assertIn('NEARBY_DOMAIN=other.your-domain.com',p.read_text())
 def test_bad_domains_fail_before_creating_configuration(self):
  for domain in ('https://nearby.your-domain.com','foo;touch-x','nearby.example.com','-bad.your-domain.com','foo..com','127.0.0.1'):
   self.run_script('init','--domain',domain,success=False)
  self.assertFalse((self.root/'.env').exists());self.assertEqual(self.calls(),[])
 def test_check_does_not_require_daemon_or_execute_env(self):
  self.init();p=self.root/'.env';marker=self.root/'should-not-exist';p.write_text(p.read_text()+f'UNRELATED=$(touch "{marker}")\n')
  self.env['FAKE_DAEMON_FAIL']='1';self.run_script('check');self.assertFalse(marker.exists());self.assertFalse(any('info' in c for c in self.calls()))
 def test_up_waits_for_health_from_any_working_directory(self):
  self.run_script('up','--domain','nearby.your-domain.com','--timeout','180')
  calls=self.calls();up=next(c for c in calls if 'up' in c)
  self.assertIn('--wait',up);self.assertIn('--wait-timeout',up);self.assertIn('180',up);self.assertIn(str(self.root),up)
  self.assertIn('CLOUDFLARE_TRUSTED_PROXIES=173.245.48.0/20,2400:cb00::/32',(self.root/'.env.cloudflare').read_text())
 def test_update_pulls_base_and_builds_before_replacing(self):
  self.init();self.run_script('update');calls=self.calls()
  build=next(i for i,c in enumerate(calls) if 'build' in c);up=next(i for i,c in enumerate(calls) if 'up' in c)
  self.assertLess(build,up);self.assertIn('--pull',calls[build]);self.assertFalse(any('caddy' in c for c in calls))
 def test_failure_reports_logs_and_does_not_remove_containers(self):
  self.init();self.env['FAKE_UP_FAIL']='1';result=self.run_script('up',success=False)
  self.assertIn('启动失败',result.stderr);self.assertTrue(any('logs' in c for c in self.calls()));self.assertFalse(any('down' in c for c in self.calls()))
 def test_stopped_daemon_prevents_build(self):
  self.init();self.env['FAKE_DAEMON_FAIL']='1';self.run_script('up',success=False);self.assertFalse(any('build' in c or 'up' in c for c in self.calls()))
 def test_download_failure_preserves_previous_proxy_configuration(self):
  self.init();path=self.root/'.env.cloudflare';old=path.read_text()
  self.env['FAKE_CURL_FAIL']='1';self.run_script('up',success=False);self.assertEqual(path.read_text(),old)
  self.assertEqual(list(self.root.glob('.cloudflare-ips.*')),[])
 def test_invalid_proxy_response_fails_closed(self):
  self.init();path=self.root/'.env.cloudflare';old=path.read_text();self.env['FAKE_CURL_BAD']='1'
  self.run_script('refresh-proxies',success=False);self.assertEqual(path.read_text(),old)
 def test_down_never_deletes_volumes_or_prunes(self):
  self.init();self.run_script('down');calls=self.calls();down=next(c for c in calls if 'down' in c)
  self.assertNotIn('-v',down);self.assertNotIn('--volumes',down);self.assertFalse(any('prune' in c for c in calls))
 def test_unsupported_version_and_unknown_actions_are_rejected(self):
  self.init();self.env['FAKE_VERSION']='1.29.2';self.run_script('up',success=False);self.run_script('destroy',success=False);self.run_script('up','--timeout','oops',success=False)

if __name__=='__main__':unittest.main()
