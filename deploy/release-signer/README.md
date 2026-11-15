# Release signer / Подписант релизов

## RU

### Офлайн-подпись на MacBook (основной путь с 31.10.2026)

Решение Владельца: ключ подписи живёт на его MacBook, а MacBook выведен из флота.
На нём нет агента Hegai Code и приложения Hegai Code, и ни у одной машины флота
нет к нему SSH-ключа. Поэтому root на хабе до ключа не дотягивается. Второй
фактор — пароль ключа. Ключ хранится зашифрованным в
`~/.hegai-release-signing/`. Сервис `signer.mjs` с TOTP (ниже) остаётся
запасным вариантом, если когда-нибудь понадобится подпись без ноутбука.

**Вывести MacBook из флота** (один раз, руками на MacBook):

```bash
launchctl bootout "gui/$(id -u)/ai.heg.ccremote.agent" 2>/dev/null
rm -f ~/Library/LaunchAgents/ai.heg.ccremote.agent.plist
# состояние агента (в нём корзина удалённых сессий) не стираем — откладываем
mv ~/cc-remote-agent ~/cc-remote-agent.removed-$(date +%F) 2>/dev/null
mv ~/.cc-remote ~/.cc-remote.removed-$(date +%F) 2>/dev/null
mv "/Applications/Hegai Code.app" ~/.Trash/ 2>/dev/null; mv "$HOME/Applications/Hegai Code.app" ~/.Trash/ 2>/dev/null
grep -n "ssh-" ~/.ssh/authorized_keys 2>/dev/null   # ключей флота быть не должно
```

После этого устройство «MacBook Владельца» отзывается на хабе.

**Один раз — ключ.** Скопировать на MacBook файл `offline-sign.mjs` (около 150
строк, только встроенный Node). Сверить с git по хешу коммита и прочитать перед
запуском:

```bash
node offline-sign.mjs setup     # пароль от 12 символов; печатает публичный ключ
```

Строку публичного ключа добавить в `deploy/release-keys.txt` (она публичная).

**Каждый релиз.** Сборка печатает sha256 внешнего бандла и выкладывает его по
https. На MacBook:

```bash
node offline-sign.mjs sign https://code.example.com/dl/external/<версия>/agent-external.mjs --keys release-keys.txt
```

`release-keys.txt` — копия `deploy/release-keys.txt`: так скрипт заранее
проверит, что подпись примут хабы и агенты. Версию скрипт берёт из самой
сборки; `--version`, если указан, должен с ней совпасть. Ключ зашифрован
scrypt и AES-256-GCM, скачивание идёт без редиректов, с таймаутом и лимитом
размера, существующие файлы не перезаписываются.

Скрипт откажет подписывать не внешнюю сборку. Он показывает sha256 — сверить
его с тем, что напечатала сборка — и после пароля печатает манифест и подпись.
Обе строки публичные: их вставляют обратно, и они коммитятся в
`deploy/selfhost/agent-release/` рядом с бандлом.

**Как это прошло в первый раз (31.10.2026, 0.3.3).** Ключ: MacBook Владельца вне
флота, `~/hegai-signer/offline-sign.mjs`; ключ в `release-keys.txt` с e81830e2.
Порядок, который сработал:

1. Добавить ключ в `release-keys.txt` и запушить — ключ вшивается во внешний
   бандл, поэтому бандл собирают ПОСЛЕ этого:
   `AGENT_EDITION=external AGENT_OUT=<файл> bash deploy/build-agent.sh`.
2. Выложить его в `/var/www/code.example.com/dl/external/<версия>/agent-external.mjs`
   на боксе хаба и сверить `curl … | sha256sum`.
3. Владелец подписывает без `--keys` (на маке нет копии файла ключей — самопроверка
   по своему ключу всё равно идёт) и присылает строку из `<бандл>.sig`.
   Манифест восстанавливается однозначно из версии и sha256.
4. Проверить подпись против ключа и коммитнуть три файла в
   `deploy/selfhost/agent-release/`. Бандл ~1,7 МБ: gateway-ревью этого пуша
   откажет (лимит диффа 500 КБ), штамп `ci-ok` получает следующий маленький
   коммит — как этот абзац.

### Подпись в приложении (Touch ID)

Нативное приложение на маке Владельца подписывает без копирования строк в чат.
Ему нужны два публичных эндпоинта нашего хаба (code.example.com); подпись
сама и есть аутентификация (хаб проверяет её по `release-keys.txt`).

Включаются только переменной `CC_REMOTE_RELEASE_DROP_DIR` на хабе (каталог,
который nginx отдаёт как `https://code.example.com/dl/external/`, например
`/var/www/code.example.com/dl/external`). Без неё оба маршрута отвечают 404.

1. На dev-box-1 из чистого main: `bash deploy/release-signer/stage-release.sh`
   (`--force` перезаписывает другой файл той же версии). Собирает внешний
   бандл, кладёт `<версия>/agent-external.mjs` на бокс хаба и атомарно пишет
   `pending.json` (`version`, `sha256`, `url`, `commit`, `createdAt`).
2. Приложение: `GET /api/release-signing/pending` (204 — ничего нет; 200 —
   поля из pending.json плюс `signed`), скачивает бандл по `url`, сверяет
   sha256, подписывает манифест после Touch ID и шлёт
   `POST /api/release-signing/signature` с `{"version","sha256","signature"}`
   (подпись — base64 от 64 байт). Ответы: 200 `{"ok":true,"keyIndex":n}`;
   400 — подпись не проходит ни одним доверенным ключом; 409 — не тот релиз,
   файл на боксе отличается от sha256 или уже лежит другая подпись; 429 —
   больше 20 попыток за 10 минут с адреса. Повтор той же подписи идемпотентен.
3. Хаб пишет рядом с бандлом `agent-external.mjs.release` и `.sig`, логирует
   `[release-signing] signed <версия> <sha12>` и шлёт строку в Telegram, если
   заданы `CC_REMOTE_OPS_TG_*`.
4. `bash deploy/release-signer/collect-signed.sh <версия>` забирает три файла,
   проверяет подпись локально по `release-keys.txt` и копирует их в
   `deploy/selfhost/agent-release/` — дальше коммит, как в пункте выше.
5. Коммит с бандлом (~1,8 МБ) пушить ОТДЕЛЬНО: `llm-review` проверяет диапазон
   пуша и на диффе больше 500 КБ отказывает — штампа `ci-ok` у этого коммита
   не будет, это ожидаемо. Следующий небольшой коммит, запушенный отдельно,
   проверяется и штампуется сам; выкатывать по нему (так шли 0.3.5 и 0.3.6).

### Сервис с TOTP (запасной вариант)

Маленький сервис, который подписывает релиз агента внешней редакции
(`docs/EXTERNAL-EDITION.md`, «Release signing»). Схема «запрос — одобрение»:

1. Машина сборки **только просит**: `sign-release.mjs` считает sha256 сборки,
   шлёт запрос (`POST /requests`, bearer-токен) и печатает id запроса и sha256.
2. Оператор открывает страницу подписанта (`GET /`) на телефоне через TLS, видит
   у каждого запроса версию, **полный sha256**, коммит и заметку, и вводит
   6-значный код из Google Authenticator рядом с тем запросом, который узнаёт.
   Подписывается ровно этот манифест. Код вводится не на машине сборки, поэтому
   утёкший с неё код ничего не подпишет.
3. `sign-release.mjs` опрашивает `GET /requests/{id}`, получает манифест и
   подпись, проверяет их по `deploy/release-keys.txt` и пишет `.release` и `.sig`.

Манифест подтверждает редакцию: `hegai-code-agent-release/1`, `edition=external`,
`version=…`, `sha256=…`. `sign-release.mjs` не станет даже просить подпись для
сборки без маркера `HEGAI_AGENT_EDITION=external` (его вкомпилирует
`deploy/build-agent.sh` с `AGENT_EDITION=external`).

**Где запускать.** На хосте **вне флота**: без агента Hegai Code, без SSH-ключей
флота, не на хабе и не на машинах, куда хаб умеет открывать терминал. Тогда root
на нашем хабе не достаёт ни ключ, ни секрет TOTP.

**Честные пределы.**
- TOTP защищает *акт подписи*. Root на самом хосте подписанта подпишет без кода.
- Оператор обязан **сверить sha256 на странице с тем, что напечатала сборка на
  доверенной ему машине**. Одобрив вслепую, он подпишет то, что попросила
  скомпрометированная машина сборки.
- Держатель токена запросов может только *просить*; подписать он не может.
- Страница и `GET /pending` открыты тому, кто достучится до сервиса (нужен код
  только для подписи). Посторонний может сжигать неверные попытки и запирать
  одобрения на время (15 мин, затем 30, 60, … до 24 ч), но не подписать.
- Подписанное — отдельно: клиент всё равно утверждает обновление своим кодом.
  Монотонность версий агенты не проверяют (хаб может отдать более старую
  подписанную сборку; откат легитимен).

**Установка.**
1. `node deploy/release-signer/setup.mjs /etc/release-signer` — создаёт `key.pem`,
   `totp-secret` и `request-token` (0600), печатает строку для
   `deploy/release-keys.txt` и `otpauth://` (+ QR, если есть `qrencode`).
   QR отсканировать Google Authenticator-ом — секрет есть только здесь и на телефоне.
2. Строку ключа добавить в `deploy/release-keys.txt`, закоммитить, выпустить
   сборки (ключ вкомпилирован в агент и хаб).
3. Скопировать `signer.mjs totp.mjs release-format.mjs` в `/opt/release-signer/`,
   поставить `release-signer.service`, поставить перед ним TLS-прокси
   (сервис слушает только `127.0.0.1:8787`). Токен запросов (`request-token`)
   скопировать на машину сборки, `chmod 600`.
4. По желанию — уведомления в Telegram о каждом запросе и каждой подписи:
   `SIGNER_TG_BOT_TOKEN_PATH` и `SIGNER_TG_CHAT_ID` (в сообщении версия и sha256).
5. Бэкап `key.pem` и `totp-secret` — офлайн.

**Выпуск.** `AGENT_EDITION=external bash deploy/build-agent.sh`, затем
`SIGN_RELEASE_TOKEN_FILE=… node deploy/release-signer/sign-release.mjs --signer https://… --bundle deploy/agent-external.mjs`
(`--commit`, `--note`, `--timeout-s` — по желанию). Команда печатает sha256 и
id запроса, ждёт до 15 минут. Оператор на телефоне открывает страницу, сверяет
sha256 и вводит код. Дальше все три файла кладутся в образ хаба
(`/app/agent-release/`).

**Защита.** Код одноразовый (повтор отклоняется, в том числе после рестарта).
5 неверных кодов — блокировка одобрений на 15 минут, следующая вдвое дольше
(30, 60, … до 24 ч), сохраняется на диске; удачный код сбрасывает счётчик.
Запросы живут 2 часа, одновременно не больше 10. Каждое событие пишется в
`SIGNER_LOG_PATH` (коды не пишутся). Поля запроса проверяются строго
(`version` — `[0-9A-Za-z._+-]`, ≤64; `sha256` — 64 hex; `commit` — hex; `note` —
≤200 символов без управляющих), страница показывает их как текст, не как HTML,
CSP запрещает внешние ресурсы.

**Страницу закрыть снаружи — обязательно.** Страница, список запросов и
одобрение сами по себе защищены только кодом. Чужой, кто их видит, подписать не
может, но пятью неверными кодами в сутки держит одобрения запертыми сколь угодно
долго. Поэтому прокси перед подписантом должен пускать на `/`, `/pending` и
`/requests/*/approve` только оператора: basic-auth с длинным паролем, mTLS или
доступ только из своей сети (Tailscale). `POST /requests` закрыт собственным
bearer-токеном.

**Ротация.** Новый ключ — добавить строкой в `release-keys.txt`, выпустить релиз,
подписанный СТАРЫМ ключом, который доверяет обоим; когда клиенты его утвердили,
подписывать новым. Не удалять единственный ключ, которому доверяет агент:
такой агент застрянет, пока его не переустановят руками. Потеря телефона:
`setup.mjs` в новую папку (новый секрет), подменить `totp-secret`, рестарт.
Подозрение на утечку ключа: новый ключ, релиз по схеме выше, затем убрать старый.
Подозрение на утечку токена запросов: заменить файл `request-token`, рестарт.

## EN

A small service that signs external-edition agent releases with a
**request / approve** flow.

1. The build machine only **asks**: `sign-release.mjs` computes the bundle's
   sha256, POSTs a request (bearer token) and prints the request id and sha256.
2. The operator opens the signer's own page (`GET /`) on their phone through TLS,
   sees each pending request's version, **full sha256**, commit and note, and
   types the 6-digit authenticator code next to the one they recognise. Exactly
   that manifest is signed. The code is never typed on the build machine, so a
   code that leaks from it signs nothing.
3. `sign-release.mjs` polls `GET /requests/{id}` (up to 15 minutes), verifies the
   returned manifest and signature against `deploy/release-keys.txt` and writes
   `.release` and `.sig` next to the bundle.

The manifest attests the edition (`hegai-code-agent-release/1`,
`edition=external`, `version=`, `sha256=`). `sign-release.mjs` refuses to even
request a signature for a bundle without the `HEGAI_AGENT_EDITION=external`
marker that `AGENT_EDITION=external bash deploy/build-agent.sh` compiles in.

**Where.** A host **outside the fleet**: no Hegai Code agent, no fleet SSH keys,
not the hub. Then root on our hub reaches neither the key nor the TOTP secret.

**Honest limits.**
- TOTP protects the *act of signing*; root on the signer host can sign without it.
- The operator must **compare the sha256 on the page with the one printed by the
  build on a machine they trust**. Approving blindly signs whatever a compromised
  build machine asked for.
- The request-token holder can only *ask*.
- The page and `GET /pending` are open to whoever can reach the service (only
  signing needs the code), so a stranger can burn failed attempts and lock
  approvals for a while (15 min, then 30, 60, … up to 24 h) but never sign.
- A signature alone installs nothing: the customer's owner still approves it.
  Agents do not enforce version monotonicity (a hub can re-offer an older signed
  bundle; rollback is legitimate).

**Setup.** `node setup.mjs /etc/release-signer` writes `key.pem`, `totp-secret`
and `request-token` (0600), prints the `deploy/release-keys.txt` line and the
`otpauth://` URI (QR if `qrencode` exists). Add the key line to the repository,
ship builds, copy `signer.mjs totp.mjs release-format.mjs` to
`/opt/release-signer/`, install `release-signer.service`, put a TLS proxy in
front (it binds `127.0.0.1:8787` only), copy `request-token` to the build
machine (mode 0600, `SIGN_RELEASE_TOKEN_FILE`). Optional Telegram notices on every
request and signature: `SIGNER_TG_BOT_TOKEN_PATH` + `SIGNER_TG_CHAT_ID`. Back up
the key and TOTP secret offline.

**Environment** (service unit): `SIGNER_KEY_PATH`, `SIGNER_TOTP_SECRET_PATH`,
`SIGNER_REQUEST_TOKEN_PATH` (>= 32 bytes), `SIGNER_STATE_DIR` (`state.json` for
replay + lockout, `requests.json`), `SIGNER_LOG_PATH`, `SIGNER_PORT`.

**Put the page behind proxy auth (required).** The page, the pending list and approve are guarded by the code alone: a stranger cannot sign, but five wrong codes a day keep approvals locked indefinitely. The proxy in front must admit only the operator to `/`, `/pending` and `/requests/*/approve` (basic auth with a long password, mTLS, or network-only access such as Tailscale). `POST /requests` has its own bearer token.

**Hardening.** Codes are single-use (also across restarts). 5 wrong codes lock
approvals for 15 minutes, each further lock doubles (30, 60, ... capped at 24 h),
persisted; a success resets the ladder. Requests expire after 2 hours, at most 10
pending. Request fields are validated strictly and shown as text, never HTML; the
page's CSP forbids external resources. The old `POST /sign` and the
`SIGN_RELEASE_CODE` variable are gone.

**Rotation.** Add the new key as a new line, release once signed by the OLD key
(trusted keys are a list), let customers approve it, then sign with the new key.
Never remove the only key an agent trusts. Lost phone: run `setup.mjs` into a
fresh directory, swap `totp-secret`, restart. Leaked request token: replace the
`request-token` file, restart.

Tests: `node --test deploy/release-signer/test/*.test.mjs`.
