import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

BIN=Path(__file__).resolve().parents[1]/'target/debug/ai-agents'
class CliTest(unittest.TestCase):
    def test_status_is_readable_and_json_remains_available(self):
        with tempfile.TemporaryDirectory() as temp:
            env=dict(os.environ,AI_AGENTS_CONFIG_DIR=temp+'/config',AI_AGENTS_STATE_DIR=temp+'/state',NO_COLOR='1')
            result=subprocess.run([str(BIN),'status'],env=env,text=True,capture_output=True,check=True)
            self.assertIn('AGENT//GRID',result.stdout)
            self.assertIn('not configured',result.stdout)
            self.assertIn('stopped',result.stdout)
            self.assertNotIn('\x1b',result.stdout)
            data=json.loads(subprocess.run([str(BIN),'status','--json'],env=env,text=True,capture_output=True,check=True).stdout)
            self.assertFalse(data['daemon']['running']);self.assertEqual(data['queued'],0)
    def test_web_uses_private_credential_and_respects_expiry_option(self):
        received=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.path,self.headers.get('Authorization'),json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                self.wfile.write(json.dumps({'url':f'http://{self.headers["Host"]}/login#token=link.'+'a'*43,'expires_at':int(time.time()*1000)+300000,'browser_expires_at':int(time.time()*1000)+2592000000}).encode())
            def log_message(self,*args):pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as temp:
                config=Path(temp)/'config';config.mkdir()
                token='writer.'+'s'*43
                (config/'write.token').write_text(token)
                (config/'config.json').write_text(json.dumps({'url':f'http://127.0.0.1:{server.server_port}','installation_id':'test'}))
                env=dict(os.environ,AI_AGENTS_CONFIG_DIR=str(config),AI_AGENTS_STATE_DIR=temp+'/state',NO_PROXY='127.0.0.1',no_proxy='127.0.0.1',NO_COLOR='1')
                result=subprocess.run([str(BIN),'web','--expires','5m','--json'],env=env,text=True,capture_output=True,check=True)
                self.assertTrue(json.loads(result.stdout)['url'].endswith('a'*43))
                self.assertNotIn(token,result.stdout+result.stderr)
                self.assertEqual(received, [('/v1/browser-links','Bearer '+token,{'schema_version':1,'expires_in':300})])
                result=subprocess.run([str(BIN),'web','--expires','1s'],env=env,text=True,capture_output=True)
                self.assertNotEqual(result.returncode,0);self.assertEqual(len(received),1)
                # CLI and daemon share an explicit proxy from private config.
                # The collector port has no listener; only the proxy can serve it.
                (config/'config.json').write_text(json.dumps({'url':'http://127.0.0.1:9','installation_id':'test','proxy_url':f'http://127.0.0.1:{server.server_port}'}))
                env.update(NO_PROXY='',no_proxy='')
                result=subprocess.run([str(BIN),'web','--json'],env=env,text=True,capture_output=True,check=True)
                self.assertEqual(received[-1][0],'http://127.0.0.1:9/v1/browser-links')
                self.assertTrue(json.loads(result.stdout)['url'].startswith('http://127.0.0.1:9/login#'))
        finally:server.shutdown();server.server_close()
