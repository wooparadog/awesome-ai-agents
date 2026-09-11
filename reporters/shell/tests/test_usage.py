"""Accounting fixtures for the shell adapter's provider response parsing."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]

class UsageTest(unittest.TestCase):
    def parse(self, agent, record):
        result = subprocess.run([
            'jq', '-Rnc', '--arg', 'agent', agent, '--arg', 'session', 's',
            '--arg', 'run', 'r', '--arg', 'model', 'gpt-5', '--arg', 'mode', 'responses',
            '-f', str(ROOT/'usage.jq'),
        ], input=json.dumps(record)+'\n', text=True, capture_output=True, check=True)
        return json.loads(result.stdout)['records'][0]

    def test_codex_actual_model_tier_and_nested_cache_usage(self):
        record = self.parse('codex', {'type':'token_usage_record', 'timestamp':'2026-09-11T00:00:00Z',
            'payload':{'response_id':'resp', 'model':'gpt-5.6-sol', 'service_tier':'fast',
                'usage':{'input_tokens':300000,'output_tokens':1000,
                    'input_tokens_details':{'cached_tokens':200000,'cache_write_tokens':10000}},
                'content':'PRIVATE'}})
        self.assertEqual(record['counters'], {'input':90000,'output':1000,'cache_read':200000,'cache_write_5m':10000,'cache_write_1h':0})
        self.assertEqual(record['model'], 'gpt-5.6-sol')
        self.assertEqual(record['pricing'], {'service_tier':'fast'})
        self.assertNotIn('PRIVATE', json.dumps(record))

    def test_claude_hour_cache_writes_are_not_also_five_minute_writes(self):
        record = self.parse('claude', {'type':'assistant', 'timestamp':'2026-09-11T00:00:00Z',
            'message':{'id':'msg','model':'claude-opus-5','usage':{'input_tokens':10,'output_tokens':20,
                'cache_creation_input_tokens':100,'cache_creation':{'ephemeral_1h_input_tokens':60},
                'service_tier':'standard','speed':'fast','inference_geo':'us'}}})
        self.assertEqual(record['counters']['cache_write_5m'], 40)
        self.assertEqual(record['counters']['cache_write_1h'], 60)
        self.assertEqual(record['pricing'], {'service_tier':'standard','speed':'fast','inference_geo':'us'})

if __name__ == '__main__':
    unittest.main()
