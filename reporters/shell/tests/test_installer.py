import importlib.machinery
import importlib.util
import unittest
import tempfile
import io
from contextlib import redirect_stdout
from unittest.mock import patch
from pathlib import Path

loader=importlib.machinery.SourceFileLoader('installer',str(Path(__file__).resolve().parents[1]/'install-hooks.py'))
spec=importlib.util.spec_from_loader(loader.name,loader)
module=importlib.util.module_from_spec(spec)
loader.exec_module(module)

class InstallerTest(unittest.TestCase):
    def test_component_installer_registers_component_hook_and_timer(self):
        self.check_installer_paths(False)
    def test_compatibility_installer_keeps_root_hook(self):
        self.check_installer_paths(True)
    def check_installer_paths(self, compat):
        component=Path(module.__file__).resolve().parent
        with tempfile.TemporaryDirectory() as temp:
            args=['install-hooks.py','--dry-run','--cloud-url','https://collector.example','--installation-id','machine','--token-file',str(Path(temp)/'unused.token'),'--timer']
            if compat: args.append('--compat')
            output=io.StringIO()
            with patch.object(module.sys,'argv',args), patch.object(module,'HOOK',str(component/'hook.sh')), patch.object(module,'CLAUDE_SETTINGS',str(Path(temp)/'claude.json')), patch.object(module,'CODEX_HOOKS',str(Path(temp)/'codex.json')), redirect_stdout(output):
                module.main()
            expected=(component.parents[1] if compat else component)/'hook.sh'
            self.assertIn(str(expected),output.getvalue())
            self.assertIn('would install and enable user reconciliation timer',output.getvalue())
            self.assertEqual(list(Path(temp).iterdir()),[])
    def test_uninstall_keeps_other_commands_in_shared_group(self):
        other={'command':'other-tool'}
        config={'hooks':{'Stop':[{'matcher':'*','hooks':[{'command':'/old/hook.sh claude Stop'},other]}]}}
        result=module.strip(config,['Stop'])
        self.assertEqual(result,{'hooks':{'Stop':[{'matcher':'*','hooks':[other]}]}})
    def test_merge_and_uninstall_preserve_other_tools(self):
        other={'hooks':[{'type':'command','command':'another-tool'}]}
        config={'other':True,'hooks':{'Stop':[other]}}
        result=module.merge(config,'claude',['Stop'],5)
        self.assertEqual(len(result['hooks']['Stop']),2)
        result=module.merge(result,'claude',['Stop'],5)
        self.assertEqual(len(result['hooks']['Stop']),2)
        self.assertEqual(module.strip(result,['Stop']),{'other':True,'hooks':{'Stop':[other]}})
    def test_path_with_spaces_is_quoted_and_recognized(self):
        original=module.HOOK
        try:
            module.HOOK='/a path/hook.sh'
            entry={'hooks':[{'command':module.command('codex','Stop')}]}
            self.assertTrue(module.is_ours(entry))
            self.assertEqual(entry['hooks'][0]['command'],"'/a path/hook.sh' codex Stop")
        finally:
            module.HOOK=original
