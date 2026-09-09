import ctypes
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ReporterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.requests = []
        self.status = 200
        test = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                test.requests.append((self.path, body))
                self.send_response(test.status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                accepted=[e['event_id'] for e in body.get('events',[])] + [r['native_record_id'] for r in body.get('records',[])]
                self.wfile.write(json.dumps({'accepted':accepted}).encode())
            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.env = dict(os.environ, AI_AGENTS_CONFIG_DIR=str(self.dir/'config'), AI_AGENTS_STATE_DIR=str(self.dir/'state'))
        token = self.dir/'source.token'
        token.write_text('id.'+'a'*43+'\n')
        self.run_reporter('init', f'http://127.0.0.1:{self.server.server_port}', 'test-machine', str(token))
        ctypes.CDLL(None).prctl(15, b'codex-test', 0, 0, 0)
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()
    def run_reporter(self, *args, data=None):
        return subprocess.run([str(ROOT/'reporter.sh'), *args], env=self.env,
                              input=json.dumps(data) if data else None, text=True, capture_output=True, check=True)
    def hook(self, event, **fields):
        return self.run_reporter('hook', 'claude', event, data={'session_id':'session', 'cwd':'/tmp/space "quote"', **fields})
    def test_canonical_and_compatibility_hook_entrypoints(self):
        for hook in (ROOT/'hook.sh', ROOT.parents[1]/'hook.sh'):
            result=subprocess.run([str(hook),'claude','Stop'],env=self.env,input=json.dumps({'session_id':'forwarded'}),text=True,capture_output=True,check=True)
            self.assertEqual(result.stdout,'')
            self.assertEqual(self.requests[-1][1]['events'][0]['native_session_id'],'forwarded')
    def test_legacy_hook_preserves_local_transport(self):
        directory=self.dir/'local-events'
        env=dict(self.env,AI_AGENTS_CONFIG_DIR=str(self.dir/'unconfigured'),AI_AGENTS_EVENT_DIR=str(directory))
        payload=json.dumps({'session_id':'legacy-local'})
        subprocess.run([str(ROOT.parents[1]/'hook.sh'),'claude','Stop'],env=env,input=payload,text=True,capture_output=True,check=True)
        files=list(directory.glob('*.json'))
        self.assertEqual(len(files),1)
        self.assertEqual(json.loads(files[0].read_text())['session_id'],'legacy-local')
    def test_private_metadata_and_identity(self):
        self.hook('UserPromptSubmit', prompt='SECRET', tool_input={'password':'SECRET'})
        self.hook('Stop')
        events = [body['events'][0] for path,body in self.requests if path=='/v1/events']
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]['execution_id'], events[1]['execution_id'])
        self.assertEqual(events[0]['run_id'], events[1]['run_id'])
        self.assertEqual(events[1]['sequence'], events[0]['sequence']+1)
        self.assertNotIn('SECRET', json.dumps(events))
        self.assertEqual((self.dir/'config/write.token').stat().st_mode & 0o777, 0o600)
    def test_offline_retry_keeps_identity_and_hook_returns(self):
        self.status = 503
        before=time.monotonic()
        self.hook('Stop')
        self.assertLess(time.monotonic()-before, 2.5)
        first=self.requests[-1][1]['events'][0]
        self.assertEqual(len(list((self.dir/'state/outbox').glob('*.json'))), 1)
        self.status=200
        (self.dir/'state/retry-at').unlink()
        self.run_reporter('flush')
        self.assertEqual(self.requests[-1][1]['events'][0], first)
        self.assertEqual(len(list((self.dir/'state/outbox').glob('*.json'))), 0)
    def test_reconcile_usage_partial_tail_and_attention(self):
        transcript=self.dir/'transcript.jsonl'
        transcript.write_text('')
        self.hook('PermissionRequest', transcript_path=str(transcript))
        record={'type':'assistant','timestamp':'2026-09-09T00:00:00Z','requestId':'request','message':{'id':'msg_test','model':'claude-opus-5','content':'SECRET','usage':{'input_tokens':10,'output_tokens':20}}}
        transcript.write_text(json.dumps(record)+'\n'+json.dumps({'partial':True}))
        self.run_reporter('reconcile')
        self.assertTrue(any(path=='/v1/presence' for path,_ in self.requests))
        usages=[body['records'][0] for path,body in self.requests if path=='/v1/usage']
        self.assertEqual(len(usages),1)
        self.assertEqual(usages[0]['counters']['input'],10)
        self.assertNotIn('SECRET',json.dumps(usages))
        self.assertTrue(any(path=='/v1/events' and body['events'][0]['source_event']=='AttentionCleared' for path,body in self.requests))
        self.run_reporter('reconcile')
        self.assertEqual(sum(path=='/v1/usage' for path,_ in self.requests),1)
    def test_codex_counters_preserve_model_across_chunks(self):
        transcript=self.dir/'rollout.jsonl'
        transcript.write_text(json.dumps({'type':'turn_context','payload':{'model':'gpt-5'}})+'\n')
        self.run_reporter('hook','codex','UserPromptSubmit',data={'session_id':'codex-session','transcript_path':str(transcript)})
        self.run_reporter('reconcile')
        with transcript.open('a') as fh:
            fh.write(json.dumps({'type':'event_msg','timestamp':'2026-09-09T00:00:00Z','payload':{'type':'token_count','info':{'total_token_usage':{'input_tokens':100,'cached_input_tokens':20,'output_tokens':5}}}})+'\n')
        self.run_reporter('reconcile')
        records=[r for path,body in self.requests if path=='/v1/usage' for r in body['records']]
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]['model'],'gpt-5')
        self.assertEqual(records[0]['measurement_kind'],'cumulative')
        self.assertEqual(records[0]['counters'],{'input':100,'output':5,'cache_read':20,'cache_write_5m':0,'cache_write_1h':0})
    def test_switching_session_preserves_transcript_history(self):
        self.hook('SessionStart')
        first=self.requests[-1][1]['events'][0]
        self.run_reporter('hook','claude','SessionStart',data={'session_id':'second'})
        second=self.requests[-1][1]['events'][0]
        self.assertEqual(first['execution_id'],second['execution_id'])
        self.assertEqual(second['run_generation'],2)
        self.assertNotEqual(first['run_id'],second['run_id'])
        self.assertEqual(len(list((self.dir/'state/history').glob('*.json'))),1)

if __name__ == '__main__':
    unittest.main()
