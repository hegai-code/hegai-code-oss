import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, isAgentCredential, runUserEnv } from '../src/child-env.js';
import { maskSecrets } from '../src/secret-mask.js';

const PEM_BEGIN = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const PEM_END = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');

test('runUserEnv sets the two vars; childEnv never passes an inherited HEGAI_RUN_USER_*', () => {
  const stale = { PATH: '/usr/bin', HEGAI_RUN_USER_ID: 'stale', HEGAI_RUN_USER_EMAIL: 'stale@x.y' };
  const without = childEnv(runUserEnv(undefined), stale);
  assert.equal(without.HEGAI_RUN_USER_ID, undefined);
  assert.equal(without.HEGAI_RUN_USER_EMAIL, undefined);
  assert.equal(without.PATH, '/usr/bin');
  const withBy = childEnv(runUserEnv({ userId: 'u-1', email: 'a.b+c@example.com' }), stale);
  assert.equal(withBy.HEGAI_RUN_USER_ID, 'u-1');
  assert.equal(withBy.HEGAI_RUN_USER_EMAIL, 'a.b+c@example.com');
  // No email: the stale one must not survive either.
  assert.equal(childEnv(runUserEnv({ userId: 'u-1' }), stale).HEGAI_RUN_USER_EMAIL, undefined);
});

test('childEnv strips an inherited HEGAI_RUN_USER_* in any letter case (Windows env is case-insensitive)', () => {
  const stale = { PATH: '/usr/bin', Hegai_Run_User_Id: 'stale', hegai_run_user_email: 'stale@x.y' };
  const without = childEnv(runUserEnv(undefined), stale);
  assert.deepEqual(Object.keys(without), ['PATH']);
  const withBy = childEnv(runUserEnv({ userId: 'u-1', email: 'a@b.c' }), stale);
  assert.deepEqual(Object.keys(withBy).sort(), ['HEGAI_RUN_USER_EMAIL', 'HEGAI_RUN_USER_ID', 'PATH']);
  assert.equal(withBy.HEGAI_RUN_USER_ID, 'u-1');
});

test('HEGAI_RUN_STATE_FILE is set from the run and any inherited HEGAI_RUN_* is stripped in any case', () => {
  const stale = { PATH: '/p', Hegai_Run_State_File: '/stale', HEGAI_RUN_OTHER: 'x' };
  assert.deepEqual(Object.keys(childEnv(runUserEnv(undefined), stale)), ['PATH']);
  const env = childEnv(runUserEnv({ userId: 'u' }, '/run/state.json'), stale);
  assert.equal(env.HEGAI_RUN_STATE_FILE, '/run/state.json');
  assert.deepEqual(Object.keys(env).sort(), ['HEGAI_RUN_STATE_FILE', 'HEGAI_RUN_USER_ID', 'PATH']);
});

test('runUserEnv drops a value outside the conservative charset, without logging it', () => {
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => { warned.push(m); };
  try {
    const env = runUserEnv({ userId: 'bad id; rm -rf', email: 'ok@example.com' });
    assert.deepEqual(env, { HEGAI_RUN_USER_EMAIL: 'ok@example.com' });
    assert.equal(warned.length, 1);
    assert.ok(!warned[0]!.includes('rm -rf'));
    assert.deepEqual(runUserEnv({ userId: 'u', email: 'a\nb@x.y' }), { HEGAI_RUN_USER_ID: 'u' });
  } finally {
    console.warn = warn;
  }
});

// A session's `env` used to print the agent's own hub credential, and the
// transcript carried it to the hub for everyone who can see the session.
test('childEnv drops the agent credentials and keeps everything else', () => {
  const env = childEnv(
    { EXTRA: '1' },
    {
      PATH: '/usr/bin',
      HOME: '/home/a',
      CC_REMOTE_TOKEN: 'fleet',
      CC_REMOTE_DEVICE_TOKEN: 'dev',
      CC_REMOTE_ENROLLMENT_CODE: 'code',
      LLM_JOURNAL_KEY: 'journal-service-secret',
      CC_REMOTE_SOMETHING_SECRET: 'x',
      CC_REMOTE_ALLOW_BYPASS: '0',
      CC_REMOTE_FILES_ROOTS: '/srv',
      ANTHROPIC_API_KEY: 'person-owns-this',
    },
  );
  assert.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY',
    'CC_REMOTE_ALLOW_BYPASS',
    'CC_REMOTE_FILES_ROOTS',
    'EXTRA',
    'HOME',
    'PATH',
  ]);
});

test('no behaviour switch the agent reads looks like a credential', () => {
  for (const name of [
    'CC_REMOTE_ALLOW_BYPASS',
    'CC_REMOTE_AUTO_APPROVE',
    'CC_REMOTE_AUTOAPPROVE',
    'CC_REMOTE_DEFAULT_PERMISSION_MODE',
    'CC_REMOTE_FILES_ROOTS',
    'CC_REMOTE_PROJECTS_ROOT',
    'CC_REMOTE_CHAT_ONLY',
    'CC_REMOTE_SYNC',
    'CC_REMOTE_AUTO_UPDATE',
    'CC_REMOTE_UPDATE_URL',
    'CC_REMOTE_HUB',
    'CC_REMOTE_MODELS',
  ]) {
    assert.equal(isAgentCredential(name), false, name);
  }
});

test('maskSecrets hides secret-shaped values and keeps the command readable', () => {
  const cases: Array<[string, string]> = [
    ['psql postgres://app:hunter2@db:5432/x', 'psql postgres://app:‹masked›@db:5432/x'],
    ['deploy --token=abc123 --verbose', 'deploy --token=‹masked› --verbose'],
    ['deploy --api-key abc123 --verbose', 'deploy --api-key ‹masked› --verbose'],
    ['GITHUB_TOKEN=a1b2c3d4e5f6 node x.js', 'GITHUB_TOKEN=‹masked› node x.js'],
    ['DB_PASSWORD="Hunter2Hunter2"', 'DB_PASSWORD=‹masked›'],
    ['{"api_key": "k3y-9f8e7d6c5b4a"}', '{"api_key": ‹masked›}'],
    ['  client_secret: s3cr3tValue99', '  client_secret: ‹masked›'],
    [
      // Assembled from parts so no scanner sees a literal key block in this file; the value is the same.
      `x\n${PEM_BEGIN}\nb3BlbnNzaC1rZXktdjEAAAAA\n${PEM_END}\ny`,
      `x\n${PEM_BEGIN}‹masked›${PEM_END}\ny`,
    ],
    ['curl -H "Authorization: Bearer 7f3a9c2e1b4d" https://x', 'curl -H "Authorization: Bearer ‹masked›" https://x'],
    ['node x --key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA', 'node x --key ‹masked›'],
    ['echo ghp_abcdefghijklmnopqrstuvwxyz0123', 'echo ‹masked›'],
  ];
  for (const [input, want] of cases) assert.equal(maskSecrets(input), want, input);
  for (const plain of [
    'node /home/a/.vscode-server/bin/abc/out/server-main.js --host=127.0.0.1',
    '/usr/bin/claude --resume 1f2e --permission-mode default',
    'git commit -m "fix token refresh"',
    'git log --author=bob',
    'ssh -o PasswordAuthentication=no host',
    'claude --resume abc --session-id 1f2e',
    'pip install sk-learn-something-longer-than-twenty',
    // code and prose that NAME a secret without containing one
    'token=$GITHUB_TOKEN git push',
    'password=None',
    'const url = `${base}?token=${token}`;',
    'Error: --password is required',
    'api_key = os.environ["API_KEY"]',
    'secret: ${{ secrets.DEPLOY_KEY }}',
    'The token expired, run claude setup-token again.',
    `printf 'Authorization: token %s' "$(cat /root/.config/forgejo/token)"`,
    '/// `Authorization: Bearer <session>` — how a native client authenticates',
    'rescheduleToken: meeting.reschedule_token,',
    'CC_REMOTE_TOKEN: dev-token is the default',
  ]) {
    assert.equal(maskSecrets(plain), plain, plain);
  }
});

// Two unbounded classes around the keyword alternation backtracked cubically:
// 16 KB of `token-` took minutes and froze the agent on every stats tick.
test('maskSecrets stays linear on hostile command lines', () => {
  const started = Date.now();
  maskSecrets('token-'.repeat(3000));
  maskSecrets('--' + 'secret'.repeat(3000) + '=x');
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test('a command line is masked strictly: the value after --password is the password', () => {
  assert.equal(maskSecrets('mysql --password correcthorse', { strict: true }), 'mysql --password ‹masked›');
  assert.equal(maskSecrets('mysql --password $PW', { strict: true }), 'mysql --password $PW');
});
