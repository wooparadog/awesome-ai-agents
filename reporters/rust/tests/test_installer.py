import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('rust_installer',Path(__file__).resolve().parents[1]/'install.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class InstallerTest(unittest.TestCase):
    def test_migration_is_idempotent_and_preserves_other_hooks_and_network(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            config=root/'custom config';config.mkdir();(config/'config.json').write_text('{}')
            binary=root/'source';binary.write_text('binary');binary.chmod(0o755)
            claude=root/'claude.json';claude.write_text('{"untouched":true}')
            codex=root/'codex.json'
            codex.write_text(json.dumps({'other':True,'hooks':{'Stop':[{'matcher':'*','hooks':[{'command':"'/old path/hook.sh' codex Stop"},{'command':'other-tool'}]}]}}))
            units=root/'xdg/systemd/user';units.mkdir(parents=True)
            (units/'ai-agents-reconcile.timer').write_text('old timer')
            (units/'ai-agents-upload.path').write_text('old watcher')
            dropin=units/'ai-agents-reconcile.service.d';dropin.mkdir()
            (dropin/'10-network.conf').write_text('[Service]\nEnvironmentFile=/private/proxy.env\n')
            state=root/'state';state.mkdir();(state/'keep').write_text('pending')
            env={'AI_AGENTS_CONFIG_DIR':str(config),'AI_AGENTS_STATE_DIR':str(state),'XDG_CONFIG_HOME':str(root/'xdg')}
            args=['install.py','--binary',str(binary),'--bin-dir',str(root/'bin space'),'--agent','codex','--service']
            with patch.dict(os.environ,env),patch.object(module,'CLAUDE_SETTINGS',str(claude)),patch.object(module,'CODEX_HOOKS',str(codex)),patch.object(module.sys,'argv',args),patch.object(module.subprocess,'run') as run,redirect_stdout(io.StringIO()):
                module.main();module.main()
                result=json.loads(codex.read_text())
                self.assertEqual(result['other'],True)
                groups=result['hooks']['Stop']
                self.assertEqual(len(groups),2)
                self.assertEqual(groups[0]['hooks'],[{'command':'other-tool'}])
                self.assertIn('ai-agents\' hook codex Stop',groups[1]['hooks'][0]['command'])
                self.assertIn(str(config),groups[1]['hooks'][0]['command'])
                self.assertEqual(claude.read_text(),'{"untouched":true}')
                self.assertEqual((units/'ai-agents.service.d/10-network.conf').read_text(),(dropin/'10-network.conf').read_text())
                service=(units/'ai-agents.service').read_text()
                self.assertIn(' daemon\n',service)
                self.assertNotIn('[Timer]',service)
                self.assertTrue(any('disable' in c.args[0] and 'ai-agents-reconcile.timer' in c.args[0] for c in run.call_args_list))
                self.assertEqual((state/'keep').read_text(),'pending')
                with patch.object(module.sys,'argv',args+['--uninstall']): module.main()
                self.assertFalse((units/'ai-agents.service').exists())
                self.assertEqual(json.loads(codex.read_text())['hooks']['Stop'][0]['hooks'],[{'command':'other-tool'}])
                self.assertTrue((config/'config.json').exists())
                self.assertTrue((state/'keep').exists())
    def test_dry_run_makes_no_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            binary=root/'binary';binary.write_text('binary');binary.chmod(0o755)
            args=['install.py','--dry-run','--binary',str(binary),'--bin-dir',str(root/'bin'),'--cloud-url','https://example.com','--installation-id','test','--token-file',str(root/'token'),'--service']
            with patch.object(module.sys,'argv',args),patch.object(module,'CLAUDE_SETTINGS',str(root/'claude')),patch.object(module,'CODEX_HOOKS',str(root/'codex')),redirect_stdout(io.StringIO()):module.main()
            self.assertEqual(list(root.iterdir()),[binary])
    def test_invalid_config_fails_before_stopping_services(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);binary=root/'binary';binary.write_text('binary');binary.chmod(0o755)
            broken=root/'codex';broken.write_text('not json')
            args=['install.py','--binary',str(binary),'--cloud-url','https://example.com','--installation-id','test','--token-file',str(root/'token'),'--service']
            with patch.object(module.sys,'argv',args),patch.object(module,'CLAUDE_SETTINGS',str(root/'claude')),patch.object(module,'CODEX_HOOKS',str(broken)),patch.object(module.subprocess,'run') as run:
                with self.assertRaises(json.JSONDecodeError):module.main()
                run.assert_not_called()
