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
        self.usage_delay = 0
        self.event_delay = 0
        self.presence_status = None
        self.retry_after = None
        test = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                test.requests.append((self.path, body))
                if self.path == '/v1/usage':
                    time.sleep(test.usage_delay)
                if self.path == '/v1/events':
                    time.sleep(test.event_delay)
                self.send_response(test.presence_status if self.path == '/v1/presence' and test.presence_status else test.status)
                if test.retry_after:
                    self.send_header('Retry-After', str(test.retry_after))
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
            self.assertEqual([body['events'][0] for path, body in self.requests if path == '/v1/events'][-1]['native_session_id'],'forwarded')
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
        first=[body['events'][0] for path, body in self.requests if path == '/v1/events'][-1]
        self.assertEqual(len(list((self.dir/'state/outbox').glob('*.json'))), 1)
        self.status=200
        (self.dir/'state/retry-at').unlink()
        self.run_reporter('flush')
        self.assertEqual([body['events'][0] for path, body in self.requests if path == '/v1/events'][-1], first)
        self.assertEqual(len(list((self.dir/'state/outbox').glob('*.json'))), 0)

    def test_background_delivery_drains_slow_events_without_blocking_hooks(self):
        (self.dir/'config/background-upload').touch()
        self.event_delay = 1.2
        before = time.monotonic()
        self.hook('UserPromptSubmit')
        self.hook('Stop')
        self.assertLess(time.monotonic()-before, 1)
        self.assertEqual(self.requests, [])
        self.run_reporter('deliver')
        events = [body['events'][0] for path, body in self.requests if path == '/v1/events']
        self.assertEqual([e['source_event'] for e in events], ['UserPromptSubmit', 'Stop'])
        presence = [body for path, body in self.requests if path == '/v1/presence'][-1]
        self.assertEqual(presence['runs'][0]['run_id'], events[-1]['run_id'])
        self.assertGreater(presence['runs'][0]['sequence'], events[-1]['sequence'])
        self.assertEqual(list((self.dir/'state/outbox').glob('*.json')), [])
        self.assertFalse((self.dir/'state/presence-pending').exists())

    def test_background_presence_failure_retries_without_replaying_liveness(self):
        (self.dir/'config/background-upload').touch()
        self.hook('UserPromptSubmit')
        self.presence_status = 503
        self.retry_after = 60
        with self.assertRaises(subprocess.CalledProcessError) as failed:
            self.run_reporter('deliver')
        self.assertEqual(failed.exception.returncode, 75)
        self.assertTrue((self.dir/'state/presence-pending').exists())
        self.assertGreaterEqual(int((self.dir/'state/retry-at').read_text()), int(time.time())+59)
        count = len(self.requests)
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_reporter('deliver')
        self.assertEqual(len(self.requests), count)
        # The process exits during backoff: fresh observation must omit it.
        runfile = next((self.dir/'state/runs').glob('*.json'))
        run = json.loads(runfile.read_text())
        run['fingerprint'] = 'different-process'
        runfile.write_text(json.dumps(run))
        (self.dir/'state/retry-at').unlink()
        self.presence_status = 200
        self.run_reporter('deliver')
        self.assertEqual(self.requests[-1][1]['runs'], [])
        self.assertEqual(sum(path == '/v1/events' for path, _ in self.requests), 1)
        self.assertFalse((self.dir/'state/presence-pending').exists())
    def test_empty_reconciliation_sends_only_changed_coverage(self):
        self.run_reporter('reconcile')
        count=len(self.requests)
        self.assertEqual(count,1)
        for _ in range(3): self.run_reporter('reconcile')
        self.assertEqual(len(self.requests),count)
        (self.dir/'state/dropped.test').touch()
        self.run_reporter('reconcile')
        self.assertEqual(len(self.requests),count+1)
        self.assertEqual(self.requests[-1][1]['dropped'],1)

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
    def test_hook_reports_fresh_presence_without_waiting_for_timer(self):
        self.hook('UserPromptSubmit')
        event = next(body['events'][0] for path, body in self.requests if path == '/v1/events')
        presence = next(body for path, body in self.requests if path == '/v1/presence')
        self.assertEqual(presence['runs'], [{key: event[key] for key in ('run_id', 'execution_id', 'sequence')}])
        self.assertGreaterEqual(presence['observed_at'], event['observed_at'])
        self.requests.clear()
        self.hook('SessionEnd')
        self.assertFalse(any(path == '/v1/presence' for path, _ in self.requests))

    def test_coverage_waits_for_upload_and_slow_batches_can_complete(self):
        transcript = self.dir/'transcript.jsonl'
        record = {'type': 'assistant', 'timestamp': '2026-09-09T00:00:00Z', 'requestId': 'request',
                  'message': {'id': 'msg_slow', 'model': 'claude-opus-5', 'usage': {'input_tokens': 10, 'output_tokens': 20}}}
        copy = dict(record, timestamp='2026-09-09T00:00:00.003Z')
        transcript.write_text(json.dumps(record)+'\n'+json.dumps(copy)+'\n')
        self.hook('UserPromptSubmit', transcript_path=str(transcript))
        self.status = 503
        self.run_reporter('reconcile')
        presence = [body for path, body in self.requests if path == '/v1/presence'][-1]
        self.assertFalse(presence['usage'])
        queued = list((self.dir/'state/outbox').glob('*.json'))
        self.assertEqual(len(queued), 1)
        self.assertEqual(len(json.loads(queued[0].read_text())['records']), 1)
        self.status = 200
        self.usage_delay = 2.1
        (self.dir/'state/retry-at').unlink()
        self.run_reporter('reconcile')
        self.assertEqual(list((self.dir/'state/outbox').glob('*.json')), [])
        presence = [body for path, body in self.requests if path == '/v1/presence'][-1]
        self.assertTrue(presence['usage'])

    def test_closed_probe_does_not_block_observed_transcript_coverage(self):
        self.hook('SessionEnd')
        self.run_reporter('reconcile')
        self.assertTrue((self.dir/'state/usage-ready').exists())
        self.hook('UserPromptSubmit', transcript_path=str(self.dir/'missing.jsonl'))
        self.run_reporter('reconcile')
        self.assertFalse((self.dir/'state/usage-ready').exists())

    def test_reconcile_discovers_late_codex_transcript_and_response_usage(self):
        self.env['CODEX_HOME'] = str(self.dir/'codex')
        self.run_reporter('hook', 'codex', 'UserPromptSubmit', data={'session_id': 'late-session'})
        sessions = self.dir/'codex/sessions'
        sessions.mkdir(parents=True)
        transcript = sessions/'rollout-late-session.jsonl'
        context = {'type': 'turn_context', 'payload': {'model': 'gpt-6-astra'}}
        response = {'type': 'token_usage_record', 'timestamp': '2026-09-09T06:00:00Z', 'payload': {
            'response_id': 'resp_test', 'thread_id': 'late-session',
            'usage': {'input_tokens': 100, 'cached_input_tokens': 20, 'cache_write_input_tokens': 10, 'output_tokens': 5}}}
        cumulative = {'type': 'event_msg', 'timestamp': '2026-09-09T06:00:00.002Z', 'payload': {
            'type': 'token_count', 'info': {'total_token_usage': {'input_tokens': 100, 'output_tokens': 5}}}}
        transcript.write_text('\n'.join(json.dumps(r) for r in [context, response, cumulative])+'\n')
        self.run_reporter('reconcile')
        records = [r for path, body in self.requests if path == '/v1/usage' for r in body['records']]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['native_record_id'], 'resp_test')
        self.assertEqual(records[0]['model'], 'gpt-6-astra')
        self.assertEqual(records[0]['measurement_kind'], 'delta')
        self.assertEqual(records[0]['counters'], {'input': 70, 'output': 5, 'cache_read': 20, 'cache_write_5m': 10, 'cache_write_1h': 0})
        self.assertTrue((self.dir/'state/usage-ready').exists())
        self.run_reporter('reconcile')
        self.assertEqual(sum(path == '/v1/usage' for path, _ in self.requests), 1)
        # Old installations replay once, with identical response IDs and no
        # cumulative duplicates, even if their previous cursor was at EOF.
        cursor = next((self.dir/'state/cursors').glob('*.json'))
        old = json.loads(cursor.read_text())
        del old['version']
        cursor.write_text(json.dumps(old))
        self.run_reporter('reconcile')
        replay = [r for path, body in self.requests if path == '/v1/usage' for r in body['records']]
        self.assertEqual(replay, records + records)

    def test_resumed_execution_observes_shared_transcript_usage(self):
        transcript = self.dir/'resumed.jsonl'
        context = {'type': 'turn_context', 'payload': {'model': 'gpt-6-astra'}}
        response = {'type': 'token_usage_record', 'timestamp': '2026-09-09T06:00:00Z', 'payload': {
            'response_id': 'resp_before_resume', 'thread_id': 'resumed-session',
            'usage': {'input_tokens': 100, 'cached_input_tokens': 20, 'output_tokens': 5}}}
        transcript.write_text(json.dumps(context)+'\n'+json.dumps(response)+'\n')
        self.run_reporter('hook', 'codex', 'UserPromptSubmit', data={
            'session_id': 'resumed-session', 'transcript_path': str(transcript)})
        self.run_reporter('reconcile')
        original = [r for path, body in self.requests if path == '/v1/usage' for r in body['records']][0]
        runs = self.dir/'state/runs'
        source = next(runs.glob('*.json'))
        old = json.loads(source.read_text())
        # Match a restarted process: the closed execution is scanned before the
        # new execution, but both refer to the same native session and file.
        source.unlink()
        (runs/'00-old.json').write_text(json.dumps(dict(old, closed=True)))
        resumed = dict(old, run_id='resumed-run', execution_id='resumed-execution')
        (runs/'99-resumed.json').write_text(json.dumps(resumed))
        self.requests.clear()
        self.run_reporter('reconcile')
        records = [r for path, body in self.requests if path == '/v1/usage' for r in body['records']]
        self.assertEqual(records, [dict(original, run_id='resumed-run')])
        self.assertEqual(len(list((self.dir/'state/cursors').glob('*.json'))), 2)
        with transcript.open('a') as fh:
            later = dict(response, timestamp='2026-09-09T06:01:00Z',
                         payload=dict(response['payload'], response_id='resp_after_resume'))
            fh.write(json.dumps(later)+'\n')
        self.requests.clear()
        self.run_reporter('reconcile')
        records = [r for path, body in self.requests if path == '/v1/usage' for r in body['records']]
        self.assertEqual({r['run_id'] for r in records}, {resumed['run_id']})
        self.assertEqual({r['native_record_id'] for r in records}, {'resp_after_resume'})
        self.requests.clear()
        self.run_reporter('reconcile')
        self.assertFalse(any(path == '/v1/usage' for path, _ in self.requests))

    def test_switching_session_preserves_transcript_history(self):
        self.hook('SessionStart')
        first=[body['events'][0] for path, body in self.requests if path == '/v1/events'][-1]
        self.run_reporter('hook','claude','SessionStart',data={'session_id':'second'})
        second=[body['events'][0] for path, body in self.requests if path == '/v1/events'][-1]
        self.assertEqual(first['execution_id'],second['execution_id'])
        self.assertEqual(second['run_generation'],2)
        self.assertNotEqual(first['run_id'],second['run_id'])
        self.assertEqual(len(list((self.dir/'state/history').glob('*.json'))),1)

if __name__ == '__main__':
    unittest.main()
