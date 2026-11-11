# SPDX-License-Identifier: GPL-3.0-or-later
"""D66: one CI run per PR push, superseded PR runs cancelled, main never cancelled, every job bounded."""
import json
import pathlib
import re
import unittest
from types import SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / '.github/workflows'


def jobs(workflow):
    body = workflow.read_text().split('\njobs:\n', 1)[1]
    for block in re.split(r'\n(?=  [A-Za-z0-9_-]+:\n)', '\n' + body):
        if match := re.match(r'\s*([A-Za-z0-9_-]+):\n', block):
            yield match.group(1), block


# CM_RUNNER moves a job to the cm-hetzner runners only when it is exactly "hetzner" and the event
# is in the explicit trusted allow-list (push, schedule, workflow_dispatch, or a same-repo
# pull_request). The labels are a constant and the variable is never parsed, so any other value,
# any fork PR (including deleted forks), or any unallowlisted event keeps ubuntu-24.04.
CM_HETZNER = ['self-hosted', 'cm-hetzner']
EVENT_ALLOWLIST = (
    r"\(github\.event_name == 'push' \|\| github\.event_name == 'schedule' \|\| "
    r"github\.event_name == 'workflow_dispatch' \|\| "
    r"\(github\.event_name == 'pull_request' && "
    r"github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)\)"
)
RUNNER_SELECTOR = re.compile(
    rf"^\$\{{\{{ {EVENT_ALLOWLIST} && vars\.CM_RUNNER == 'hetzner' && "
    r"fromJSON\('(?P<labels>\[\"self-hosted\",\"cm-hetzner\"\])'\) \|\| '(?P<default>ubuntu-24\.04)' \}\}$")


class _CIString(str):
    """GitHub Actions string comparison (`==` / `!=`) is case-insensitive."""

    def __eq__(self, other):
        return isinstance(other, str) and self.casefold() == other.casefold()

    def __ne__(self, other):
        return not self.__eq__(other)


class _NullContext:
    """GitHub Actions dereferences missing/null context properties to null instead of raising."""

    def __getattr__(self, _name):
        return self

    def __bool__(self):
        return False


_NULL = _NullContext()


def runs_on_values():
    """(workflow, runs-on) for every job; a block runs-on (a YAML list or mapping) is joined into one string."""
    for workflow in sorted(WORKFLOWS.glob('*.yml')):
        lines = workflow.read_text().splitlines()
        for i, line in enumerate(lines):
            if match := re.match(r'^    runs-on:(.*)$', line):
                value = [match.group(1).strip()]
                for following in lines[i + 1:]:
                    if not following.startswith('      '):
                        break
                    value.append(following.strip())
                yield workflow.name, '\n'.join(v for v in value if v)


def select_runner(
    runs_on,
    variables,
    *,
    event_name='push',
    head_repo='codemyriad/cassini-browser-protocol',
    repository='codemyriad/cassini-browser-protocol',
):
    """Evaluate a job's runs-on expression under GitHub Actions event, repo, and vars contexts."""
    if not (runs_on.startswith('${{') and runs_on.endswith('}}')):
        return runs_on
    expr = runs_on.removeprefix('${{').removesuffix('}}').strip()
    expr = expr.replace('&&', ' and ').replace('||', ' or ')
    repo_obj = _NULL if head_repo is None else SimpleNamespace(full_name=_CIString(head_repo))
    event = SimpleNamespace(pull_request=SimpleNamespace(head=SimpleNamespace(repo=repo_obj)))
    github = SimpleNamespace(
        event_name=_CIString(event_name),
        repository=_CIString(repository),
        event=event if event_name in ('pull_request', 'pull_request_target') else _NULL,
    )
    vars_ns = SimpleNamespace(CM_RUNNER=_CIString(variables.get('CM_RUNNER') or ''))
    return eval(expr, {'__builtins__': {}}, {'github': github, 'vars': vars_ns, 'fromJSON': json.loads})


class CiHygieneTests(unittest.TestCase):
    def test_ci_runs_on_pull_requests_and_on_pushes_to_main_only(self):
        # A branch push with an open PR used to run the whole contract twice.
        trigger = re.search(r'^on:(.*?)^permissions:', (WORKFLOWS / 'ci.yml').read_text(), re.M | re.S)
        self.assertEqual(trigger and trigger.group(1), '\n  push:\n    branches: [main]\n  pull_request:\n')

    def test_only_superseded_pull_request_runs_are_cancelled(self):
        # Each main push has its own group (run_id): a shared group would drop a pending main run.
        text = (WORKFLOWS / 'ci.yml').read_text()
        self.assertIn('\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.event_name == '
                      "'pull_request' && github.event.pull_request.number || github.run_id }}\n"
                      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n", text)

    def test_talk_archives_are_verified_cached_before_stack_creation(self):
        text = (WORKFLOWS / 'ci.yml').read_text()
        restore = text.index('Restore checksum-addressed Talk archives')
        verify = text.index('Verify or fetch the locked archives before starting Docker')
        save = text.index('Save verified Talk archives')
        start = text.index('Start a locked Nextcloud 34 and Talk 24 stack')
        self.assertLess(restore, verify)
        self.assertLess(verify, save)
        self.assertLess(save, start)
        self.assertNotIn('restore-keys:', text)
        self.assertIn('CASSINI_COMPAT_APP_CACHE:', text)
        self.assertIn('git -C talk-harness apply --check', text)
        self.assertIn('PROJECT_NAME: cassini-extension-nextcloud-${{ github.run_id }}-${{ github.run_attempt }}', text)
        self.assertIn("if: always() && steps.talk-stack.outputs.started == 'true'", text)

    def test_every_job_has_a_timeout(self):
        # GitHub's default is 360 min: a hung job holds a runner for six hours.
        missing = [f'{workflow.name}:{name}' for workflow in sorted(WORKFLOWS.glob('*.yml'))
                   for name, block in jobs(workflow)
                   if not re.search(r'^    timeout-minutes: \d+$', block, re.M)]
        self.assertEqual(missing, [])

    def test_runner_variable_only_selects_constant_labels(self):
        variable = [(name, value) for name, value in runs_on_values() if 'vars.' in value]
        self.assertEqual([name for name, _ in variable], ['ci.yml'])
        for name, value in variable:
            self.assertRegex(value, RUNNER_SELECTOR, name)
            self.assertNotIn('fromJSON(vars', value, name)

    def test_every_runs_on_is_a_hosted_image_or_the_selector(self):
        # Nothing else may reach runs-on: no literal self-hosted labels, no variable in a block-style runs-on.
        hosted = re.compile(r'^(?:ubuntu|macos|windows)-[0-9a-z.-]+$')
        for name, value in runs_on_values():
            with self.subTest(workflow=name):
                self.assertTrue(hosted.match(value) or RUNNER_SELECTOR.match(value), value)

    def test_runner_selection_falls_back_to_github_for_every_other_value_and_for_fork_prs(self):
        for name, value in runs_on_values():
            if 'vars.' not in value:
                continue
            for event_name, head_repo in (
                ('push', None),
                ('schedule', None),
                ('workflow_dispatch', None),
                ('pull_request', 'codemyriad/cassini-browser-protocol'),
            ):
                for setting in (None, '', ' ', 'garbage{', '["self-hosted","cm-hetzner"]',
                                '["self-hosted","cm-hetzne"]', 'hetzner-typo', 'true', 'github'):
                    variables = {} if setting is None else {'CM_RUNNER': setting}
                    with self.subTest(workflow=name, event=event_name, value=setting):
                        self.assertEqual(
                            select_runner(value, variables, event_name=event_name, head_repo=head_repo),
                            'ubuntu-24.04',
                        )
                for setting in ('hetzner', 'Hetzner'):
                    with self.subTest(workflow=name, event=event_name, value=setting):
                        self.assertEqual(
                            select_runner(value, {'CM_RUNNER': setting}, event_name=event_name, head_repo=head_repo),
                            CM_HETZNER,
                        )
            for untrusted_head in ('fork/cassini-browser-protocol', 'codemyriad/other-repo', '', None):
                with self.subTest(workflow=name, untrusted_head=untrusted_head):
                    self.assertEqual(
                        select_runner(
                            value,
                            {'CM_RUNNER': 'hetzner'},
                            event_name='pull_request',
                            head_repo=untrusted_head,
                        ),
                        'ubuntu-24.04',
                    )
            for prohibited_event in (
                'pull_request_target',
                'workflow_run',
                'issue_comment',
                'pull_request_review',
                'pull_request_review_comment',
                'discussion_comment',
                'release',
                'merge_group',
            ):
                with self.subTest(workflow=name, event=prohibited_event):
                    self.assertEqual(
                        select_runner(
                            value,
                            {'CM_RUNNER': 'hetzner'},
                            event_name=prohibited_event,
                            head_repo='codemyriad/cassini-browser-protocol',
                        ),
                        'ubuntu-24.04',
                    )


if __name__ == '__main__':
    unittest.main()
