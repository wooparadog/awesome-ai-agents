"""Black-box tests: real daemon, Unix wakeups, durable state, fake collector."""
import ctypes
import hashlib
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
BIN = Path(os.environ.get("AI_AGENTS_TEST_BINARY", ROOT / "target/debug/ai-agents"))

class DaemonTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.requests = []
        self.http_status = 200
        self.delay = 0
        self.retry_after = None
        self.ack = True
        self.reject_sid = None
        self.daemon = None
        self.log = open(self.dir / "daemon.log", "w+")
        test = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                test.requests.append((self.path, body))
                if self.path == '/v1/events':
                    time.sleep(test.delay)
                status = test.http_status
                if any(e['native_session_id'] == test.reject_sid for e in body.get('events', [])):
                    status = 409
                self.send_response(status)
                if test.retry_after:
                    self.send_header('Retry-After', str(test.retry_after))
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                accepted = [e['event_id'] for e in body.get('events', [])] + [r['native_record_id'] for r in body.get('records', [])]
                try:
                    self.wfile.write(json.dumps({'accepted': accepted if test.ack else []}).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *args): pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = dict(os.environ, AI_AGENTS_CONFIG_DIR=str(self.dir/'config'), AI_AGENTS_STATE_DIR=str(self.dir/'state'), CODEX_HOME=str(self.dir/'codex'), NO_PROXY='127.0.0.1', no_proxy='127.0.0.1')
        token = self.dir/'source.token'
        token.write_text('id.'+'a'*43)
        self.command('init', f'http://127.0.0.1:{self.server.server_port}', 'test', str(token))
        ctypes.CDLL(None).prctl(15, b'codex-test', 0, 0, 0)
    def tearDown(self):
        self.stop()
        self.log.close()
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()
    def command(self, *args, payload=None):
        return subprocess.run([str(BIN), *args], env=self.env, input=json.dumps(payload) if payload else None, text=True, capture_output=True, check=True, timeout=3)
    def hook(self, event='Stop', agent='codex', sid='session', **extra):
        return self.command('hook', agent, event, payload={'session_id':sid, **extra})
    def start(self):
        self.daemon = subprocess.Popen([str(BIN), 'daemon'], env=self.env, stdout=self.log, stderr=self.log)
        self.wait(lambda: (self.dir/'state/daemon.sock').exists())
    def stop(self, kill=False):
        if self.daemon:
            if kill: self.daemon.kill()
            else: self.daemon.terminate()
            self.daemon.wait(timeout=3)
            self.daemon = None
    def wait(self, condition, timeout=5):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            if condition(): return
            if self.daemon and self.daemon.poll() is not None:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(.02)
        self.log.seek(0)
        self.fail('condition timed out: '+self.log.read())
    def events(self):
        return [e for path,body in self.requests if path=='/v1/events' for e in body['events']]
    def usage(self):
        return [r for path,body in self.requests if path=='/v1/usage' for r in body['records']]
    def drain(self):
        self.wait(lambda: not list((self.dir/'state/inbox').glob('*.json')) and not list((self.dir/'state/outbox').glob('*.json')))
    def test_offline_intake_privacy_batching_and_resume(self):
        for event in ['SessionStart','UserPromptSubmit','Stop']:
            result = self.hook(event, prompt='SECRET', message='SECRET', tool_input={'password':'SECRET'})
            self.assertEqual(result.stdout,'')
        self.assertEqual(len(list((self.dir/'state/inbox').glob('*.json'))),3)
        self.assertNotIn('SECRET',''.join(p.read_text() for p in (self.dir/'state/inbox').glob('*.json')))
        self.start()
        self.drain()
        events = self.events()
        self.assertEqual([e['source_event'] for e in events],['SessionStart','UserPromptSubmit','Stop'])
        self.assertEqual(len({e['run_id'] for e in events}),1)
        self.assertEqual(sum(p=='/v1/events' for p,_ in self.requests),1)
        self.hook('SessionEnd')
        self.drain()
        self.hook('SessionStart')
        self.drain()
        self.assertNotEqual(self.events()[-1]['run_id'],events[0]['run_id'])
        self.assertEqual(self.events()[-1]['execution_id'],events[0]['execution_id'])
        self.assertEqual((self.dir/'config/write.token').stat().st_mode & 0o777,0o600)
    def test_slow_network_does_not_block_hooks(self):
        self.delay = 1.5
        self.start()
        self.hook('UserPromptSubmit')
        self.wait(lambda: bool(self.events()))
        before = time.monotonic()
        self.hook('Stop')
        self.assertLess(time.monotonic()-before,.5)
        self.wait(lambda: not list((self.dir/'state/inbox').glob('*.json')),timeout=.8)
        self.drain()
        self.assertEqual([e['source_event'] for e in self.events()],['UserPromptSubmit','Stop'])
    def test_server_backoff_survives_restart_and_no_stale_presence(self):
        self.http_status = 503
        self.retry_after = 60
        self.hook('Stop')
        self.start()
        self.wait(lambda: (self.dir/'state/retry-at').exists())
        original = self.events()[0]
        self.assertGreaterEqual(int((self.dir/'state/retry-at').read_text()),int(time.time())+59)
        self.stop(kill=True)
        self.start()
        time.sleep(.2)
        self.assertEqual(len(self.events()),1)
        self.stop()
        # Process identity is no longer valid during retry.
        runfile = next((self.dir/'state/runs').glob('*.json'))
        run = json.loads(runfile.read_text()); run['fingerprint']='reused-pid'; runfile.write_text(json.dumps(run))
        (self.dir/'state/retry-at').unlink()
        self.http_status = 200
        self.start()
        self.drain()
        self.wait(lambda:any(p=='/v1/presence' for p,_ in self.requests))
        self.assertEqual(self.events()[1],original)
        self.assertEqual([b for p,b in self.requests if p=='/v1/presence'][-1]['runs'],[])
        self.assertTrue(any(e['source_event']=='SessionEnd' for e in self.events()))
    def test_missing_ack_is_not_discarded(self):
        self.ack=False
        self.hook()
        self.start()
        self.wait(lambda:(self.dir/'state/retry-at').exists())
        self.assertEqual(len(list((self.dir/'state/outbox').glob('*.json'))),1)
    def test_poison_event_does_not_discard_valid_batch_members(self):
        self.reject_sid='bad'
        self.hook(sid='bad')
        self.hook(sid='good')
        self.start()
        self.drain()
        self.assertTrue(any(len(b['events'])==1 and b['events'][0]['native_session_id']=='good' for p,b in self.requests if p=='/v1/events'))
        self.assertTrue(list((self.dir/'state/quarantine').glob('*.json')))
    def test_single_owner(self):
        self.start()
        second=subprocess.run([str(BIN),'daemon'],env=self.env,capture_output=True,text=True,timeout=2)
        self.assertNotEqual(second.returncode,0)
        self.assertIn('another reporter',second.stderr)
    def test_incremental_usage_partial_tail_rotation_and_finalization(self):
        transcript=self.dir/'transcript.jsonl'
        record={'type':'assistant','timestamp':'2026-09-10T01:00:00Z','requestId':'request','message':{'id':'msg','model':'claude-opus-5','usage':{'input_tokens':10,'output_tokens':5},'content':'SECRET'}}
        transcript.write_text(json.dumps(record)+'\n'+json.dumps({'partial':True}))
        self.hook('UserPromptSubmit',agent='claude',transcript_path=str(transcript))
        self.start()
        self.wait(lambda:len(self.usage())==1)
        self.assertNotIn('SECRET',json.dumps(self.usage()))
        self.assertFalse((self.dir/'state/usage-ready').exists())
        with transcript.open('a') as f:f.write('\n')
        self.command('reconcile')
        self.wait(lambda:(self.dir/'state/usage-ready').exists())
        self.assertEqual(len(self.usage()),1)
        self.hook('SessionEnd',agent='claude',transcript_path=str(transcript))
        self.drain()
        self.wait(lambda:any(json.loads(p.read_text()).get('finalized') for p in (self.dir/'state/cursors').glob('*.json')))
        with transcript.open('a') as f:f.write(json.dumps(dict(record,message=dict(record['message'],id='later')))+'\n')
        self.command('reconcile');time.sleep(.2)
        self.assertEqual(len(self.usage()),1)
        self.hook('SessionStart',agent='claude',transcript_path=str(transcript))
        self.wait(lambda:len(self.usage())==3)
        self.assertEqual({r['native_record_id'] for r in self.usage()},{'msg|request','later|request'})
        # A replaced/truncated file resets only this run's cursor.
        replacement=self.dir/'replacement'
        replacement.write_text(json.dumps(dict(record,message=dict(record['message'],id='rotated')))+'\n')
        replacement.replace(transcript)
        self.command('reconcile')
        self.wait(lambda:any(r['native_record_id']=='rotated|request' for r in self.usage()))
    def test_migrates_shell_run_outbox_and_cursor(self):
        shell=ROOT.parent/'shell/reporter.sh'
        (self.dir/'config/background-upload').touch()
        transcript=self.dir/'rollout.jsonl'
        context={'type':'turn_context','payload':{'model':'gpt-6-astra'}}
        record={'type':'token_usage_record','timestamp':'2026-09-10T01:00:00Z','payload':{'response_id':'response','thread_id':'legacy','usage':{'input_tokens':100,'cached_input_tokens':20,'cache_write_input_tokens':10,'output_tokens':5}}}
        transcript.write_text(json.dumps(context)+'\n'+json.dumps(record)+'\n')
        subprocess.run([str(shell),'hook','codex','UserPromptSubmit'],env=self.env,input=json.dumps({'session_id':'legacy','transcript_path':str(transcript)}),text=True,check=True)
        old=json.loads(next((self.dir/'state/outbox').glob('*.json')).read_text())['event']
        self.start()
        self.wait(lambda:len(self.usage())==1)
        self.drain()
        self.assertEqual(self.events()[0],old)
        self.assertEqual(self.usage()[0]['counters'],{'input':70,'output':5,'cache_read':20,'cache_write_5m':10,'cache_write_1h':0})
        self.stop()
        # The Rust cursor is also readable by the old adapter for rollback.
        cursor=next((self.dir/'state/cursors').glob('*.json'))
        self.assertEqual(cursor.stem,hashlib.sha256((old['run_id']+'\n'+str(transcript)).encode()).hexdigest())
        subprocess.run([str(ROOT.parent/'shell/usage.sh'),str(self.dir/'state')],env=self.env,check=True)
        self.assertEqual(list((self.dir/'state/outbox').glob('*.json')),[])
        self.hook(sid='legacy')
        self.start();self.drain()
        self.assertEqual(self.events()[-1]['run_id'],old['run_id'])
    def test_late_codex_discovery_and_response_mode(self):
        self.hook('UserPromptSubmit',sid='late')
        self.start();self.drain()
        folder=self.dir/'codex/archived_sessions';folder.mkdir(parents=True)
        lines=[{'type':'turn_context','payload':{'model':'gpt-6-astra'}},
               {'type':'token_usage_record','timestamp':'2026-09-10T01:00:00Z','payload':{'response_id':'response','usage':{'input_tokens':100,'cached_input_tokens':20,'output_tokens':3}}},
               {'type':'event_msg','timestamp':'2026-09-10T01:00:00Z','payload':{'type':'token_count','info':{'total_token_usage':{'input_tokens':100,'output_tokens':3}}}}]
        (folder/'rollout-late.jsonl').write_text(''.join(json.dumps(line)+'\n' for line in lines))
        self.command('reconcile')
        self.wait(lambda:len(self.usage())==1)
        self.assertEqual(self.usage()[0]['native_record_id'],'response')
        self.assertEqual(self.usage()[0]['model'],'gpt-6-astra')
        self.assertEqual(self.usage()[0]['measurement_kind'],'delta')
    def test_archived_shell_runs_never_reuse_execution_sequences(self):
        shell=ROOT.parent/'shell/reporter.sh'
        (self.dir/'config/background-upload').touch()
        for sid in ('old','current'):
            subprocess.run([str(shell),'hook','codex','Stop'],env=self.env,input=json.dumps({'session_id':sid}),text=True,check=True)
        archived=next((self.dir/'state/history').glob('*.json'))
        old=json.loads(archived.read_text())
        self.assertFalse(old['closed'])
        old['fingerprint']='dead-process';archived.write_text(json.dumps(old))
        self.start();self.drain()
        time.sleep(.15)
        self.assertEqual([e['source_event'] for e in self.events()],['Stop','Stop'])
        self.assertEqual(len({(e['execution_id'],e['sequence']) for e in self.events()}),2)
        self.assertTrue(json.loads(archived.read_text())['closed'])
        self.hook(sid='third');self.drain()
        self.assertEqual([e['source_event'] for e in self.events()],['Stop','Stop','Stop'])
    def test_cached_shell_hook_forwards_to_daemon(self):
        (self.dir/'config/daemon-binary').write_text(str(BIN)+'\n')
        self.start()
        subprocess.run([str(ROOT.parent/'shell/hook.sh'),'codex','Stop'],env=self.env,input=json.dumps({'session_id':'cached'}),text=True,check=True)
        self.drain()
        self.assertEqual(self.events()[0]['native_session_id'],'cached')

    def test_unchanged_local_scans_do_not_contact_collector(self):
        self.start()
        self.wait(lambda: any(p=='/v1/presence' for p,_ in self.requests))
        time.sleep(.1)
        before=len(self.requests)
        self.command('reconcile')
        time.sleep(.15)
        self.command('reconcile')
        time.sleep(.15)
        self.assertEqual(len(self.requests),before)

    def test_missing_transcript_logs_cause_once_and_reports_recovery(self):
        transcript=self.dir/'missing "quoted".jsonl'
        self.hook('SessionEnd',agent='claude',sid='missing-history',transcript_path=str(transcript))
        self.start()
        def diagnostics(prefix):
            text=(self.dir/'daemon.log').read_text()
            return [json.loads(line.split(': ',1)[1]) for line in text.split('\n')[:-1] if line.startswith(prefix+': ')]
        self.wait(lambda:len(diagnostics('usage coverage incomplete'))==1)
        first=diagnostics('usage coverage incomplete')[0]
        self.assertEqual(first['reason'],'transcript_missing')
        self.assertEqual(first['agent'],'claude')
        self.assertEqual(first['native_session_id'],'missing-history')
        self.assertTrue(first['closed'])
        self.assertEqual(first['transcript'],str(transcript))
        for _ in range(2):
            self.command('reconcile')
            time.sleep(.1)
        self.assertEqual(diagnostics('usage coverage incomplete'),[first])
        self.assertFalse((self.dir/'state/usage-ready').exists())
        transcript.write_text('')
        self.command('reconcile')
        self.wait(lambda:len(diagnostics('usage coverage issue cleared'))==1)
        self.assertEqual(diagnostics('usage coverage issue cleared')[0]['reason'],'transcript_found')
        self.wait(lambda:(self.dir/'state/usage-ready').exists())
        transcript.unlink()
        self.command('reconcile')
        self.wait(lambda:len(diagnostics('usage coverage incomplete'))==2)
        self.assertEqual(diagnostics('usage coverage incomplete')[1],first)
        runfile=next((self.dir/'state/runs').glob('*.json'))
        old=time.time()-8*86400;os.utime(runfile,(old,old))
        self.command('reconcile')
        self.wait(lambda:len(diagnostics('usage coverage issue cleared'))==2)
        self.assertEqual(diagnostics('usage coverage issue cleared')[1]['reason'],'outside_retention')

    def test_write_ahead_recovery(self):
        dest=self.dir/'state/history/test.json'
        source=self.dir/'state/inbox/committed.json';source.write_text('{}')
        value={'closed':True,'run_id':'recovered','agent':'codex'}
        (self.dir/'state/transaction.json').write_text(json.dumps({'writes':[[str(dest),value]],'delete':str(source)}))
        self.start()
        self.wait(lambda:not (self.dir/'state/transaction.json').exists())
        self.assertEqual(json.loads(dest.read_text()),value)
        self.assertFalse(source.exists())

if __name__=='__main__': unittest.main()
