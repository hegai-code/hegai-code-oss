# Hegai Code

**Hegai Code** — центральный сервис, который показывает сессии **Claude Code** и **OpenAI Codex** со всех ваших машин в одном месте и позволяет ими управлять: из браузера, нативных приложений iOS и Android, настольной оболочки (Windows, macOS) и Telegram. Сессии и файлы остаются на ваших машинах; сервер только маршрутизирует и хранит каталог и реплики расшифровок.

**Quick start (English).** Self-host the hub on a Linux server with Docker Compose v2, a domain pointing at it, and ports 80/443 open:

```bash
git clone https://github.com/hegai-code/hegai-code-oss.git && cd hegai-code-oss/deploy/selfhost
sudo ./install.sh code.example.com owner@example.com
```

Then connect machines with `curl -fsSL https://code.example.com/go | bash`. Details: [English summary below](#english), [deploy/selfhost/README.md](deploy/selfhost/README.md) (Russian), [AGENTS.md](AGENTS.md) for coding agents. No server yet? See [Попробовать локально](#попробовать-локально).

## Редакции

Один код, две редакции (выбираются конфигурацией, не форком):

| | внутренняя (облако HegAI) | внешняя (ваш сервер) |
|---|---|---|
| Где работает hub | у нас | у вас, `docker compose` |
| Вход | Google, Telegram, Apple, SSO HegAI | локальный владелец (пароль + код аутентификатора), OIDC (Google Workspace, Keycloak, Entra и др.) |
| Обновления агентов | вместе с выкладкой hub | только релиз с **нашей подписью** и **одобренный вашим владельцем** кодом аутентификатора |
| Доступ вендора | полный (наш парк) | **нет** по умолчанию; временный доступ поддержки — только по вашему решению, с журналом |
| Адреса HegAI | по умолчанию | нет; незаданное выключено |

Подробно — [docs/EXTERNAL-EDITION.md](docs/EXTERNAL-EDITION.md).

## Быстрый старт (внешняя редакция)

Нужны сервер с Docker (Compose v2), домен с A/AAAA-записью на сервер и открытые порты 80 и 443.

```bash
git clone https://github.com/hegai-code/hegai-code-oss.git && cd hegai-code-oss/deploy/selfhost
sudo ./install.sh code.example.com owner@example.com
# .env с секретами → hub в Docker (первый раз 10–20 минут) → этот сервер
# подключается сам → печатается одноразовая ссылка настройки владельца
```

Дальше — подключение машин (`curl -fsSL https://code.example.com/go | bash`), вход в Claude Code и Codex своими аккаунтами, OIDC, резервные копии: **[deploy/selfhost/README.md](deploy/selfhost/README.md)**.

### Что нужно получить у вендора

Два адреса выдаёт вендор, в репозитории их нет: `CC_REMOTE_PUSH_RELAY_URL` (push-уведомления в iOS/Android) и `CC_REMOTE_APP_DL` (подписанные сборки настольных приложений). Спросите на info@heg.ai (публичный контакт, он же в [SECURITY.md](SECURITY.md)). Без них всё остальное работает: веб, агенты, сессии, вход, мобильные приложения без push; настольные приложения не скачать, остаётся браузер.

## Приложения

- iPhone: [App Store](https://apps.apple.com/ru/app/hegai-code/id6789674573). Чтобы подключить свой сервер: «Другой хаб / токен», затем адрес вашего сервера. В более старых версиях приложения адрес вводится целиком: `wss://code.example.com/mobile/ui`.
- Android: [Google Play](https://play.google.com/store/apps/details?id=net.hegai.code). Чтобы подключить свой сервер: «Другой сервер».

Вход идёт через `<hub>/native-signin`. Исходники приложений лежат в `ios/` и `android/`.

## Попробовать локально

Честно: **установщик на ноутбуке без домена не работает.** `install.sh` и Caddy рассчитаны на публичный домен с настоящим сертификатом. Агенты подключаются по `wss://`, а у `localhost` Caddy выдал бы сертификат собственного внутреннего CA, которому ни агент (Node), ни `curl` в `connect-host.sh` не доверяют. Такой вариант мы не проверяли и не описываем; доверенных обходных команд у нас нет.

Без сервера можно попробовать продукт из исходников: hub и агент на одной машине, без TLS и без входа, `http://localhost:4319`. Нужны Node 20.19–24 и Rust stable. **Не запускайте этот агент на машине, где уже работает другой агент Hegai Code** (две записи в одну сессию портят её).

```bash
git clone https://github.com/hegai-code/hegai-code-oss.git && cd hegai-code-oss
npm ci
npm run build --workspace shared && npm run build

# терминал 1: hub (раздаёт собранный веб на :4319)
PORT=4319 CC_REMOTE_TOKEN=dev-token WEB_DIST=web/dist cargo run --manifest-path server-rs/Cargo.toml

# терминал 2: агент этой машины
CENTRAL_URL=ws://127.0.0.1:4319 CC_REMOTE_TOKEN=dev-token npm run start --workspace agent
```

Это режим разработки, а не внешняя редакция: локальный владелец, OIDC и подписанные обновления здесь не задействованы. Подробнее — [CONTRIBUTING.md](CONTRIBUTING.md). Для постоянного использования разверните сервер по быстрому старту выше.

## Архитектура в десяти строках

1. На каждой машине работает небольшой **агент** (`agent/`): находит сессии Claude Code и Codex, запускает и возобновляет их, отдаёт файлы, git и терминал.
2. **Агенты звонят сами.** Входящих портов на ваших машинах нет; единственный слушающий процесс — hub.
3. **Hub** (`server-rs/`, Rust/axum) — единственный сервер: маршрутизация, права доступа, блокировки записи, SQLite-каталог и реплики расшифровок. Он же раздаёт веб-приложение.
4. **Один писатель на сессию.** Две записи в одну расшифровку портят её: hub держит блокировку, агент перепроверяет живость перед возобновлением, «забрать сессию» подтверждает смерть прежнего писателя.
5. Протокол описан zod-схемами в `shared/`; любое изменение начинается там.
6. Клиенты одного протокола: `web/` (React/Vite), `ios/`, `android/`, `windows/` (Tauri-оболочка для Windows и macOS), `tgbot/` (Telegram).
7. `server/` — CLI для разработки и дымовые тесты, гоняющие hub целиком без браузера (это не сервер).
8. `skills/` — рабочие процессы по категориям сессий, встроенные в агент.
9. `deploy/selfhost/` — весь комплект установки для клиента: Dockerfile, Compose, Caddy, `install.sh`.
10. Подробная карта — [ARCHITECTURE.md](ARCHITECTURE.md); как собирать и менять — [CONTRIBUTING.md](CONTRIBUTING.md); визуальные правила — [DESIGN.md](DESIGN.md).

## Модель безопасности

- **Агенты звонят наружу, hub — единственный слушатель.** Не нужно открывать порты на рабочих машинах.
- **Подписанные релизы агента.** Внешний агент ставит самообновление только из манифеста с подписью Ed25519 нашим ключом (`deploy/release-keys.txt`, он вкомпилирован в агент и hub) и только если хеш совпал. Ключ подписи живёт в отдельном сервисе вне парка (`deploy/release-signer/`), подпись ставится по коду аутентификатора.
- **Одобрение владельца.** Hub раздаёт агентам только ту сборку, которую администратор вашей установки одобрил своим кодом аутентификатора; предыдущая сохраняется для отката.
- **Доступ поддержки — по запросу.** По умолчанию у нас нет входа в вашу установку. Владелец может открыть доступ на 1–72 часа с ролью; создаётся отдельный аккаунт, каждое его действие пишется в журнал, который видит владелец; доступ закрывается по истечении срока или кнопкой.
- **Аккаунты.** Новые аккаунты активируются только по поручительству (создал владелец/админ или вход с разрешённого домена); остальные попадают в очередь одобрения.
- **Ограничения** (честно): TOTP защищает акт подписи, но тот, у кого есть root на хосте подписи, подпишет и без него; hub может повторно предложить более старую, но валидно подписанную сборку. Подробности — [docs/EXTERNAL-EDITION.md](docs/EXTERNAL-EDITION.md) и [SECURITY.md](SECURITY.md).

## Сборка и проверка из исходников

```bash
npm ci
npm run build --workspace shared && npm run build
npm test
npm run lint
cargo test   --manifest-path server-rs/Cargo.toml
cargo clippy --manifest-path server-rs/Cargo.toml --all-targets -- -D warnings
cargo fmt    --manifest-path server-rs/Cargo.toml --check
```

Node 20.19–24, Rust stable. Файл `deploy/agent.mjs` в этом репозитории — заглушка: hub встраивает его при компиляции, а настоящий пакет агента собирается `bash deploy/build-agent.sh` (внешняя редакция: `AGENT_EDITION=external`, это делает Dockerfile). Нативные клиенты собираются по своим README: [ios/](ios/README.md), [android/](android/README.md).

## Лицензия

Две лицензии, по папкам (подробно — [LICENSE](LICENSE)):

- **Apache-2.0** — агент, протокол, веб, iOS, Android, настольная оболочка, Telegram-клиент, скиллы, подписант релизов, установщики. Делайте с этим что угодно, в том числе коммерчески.
- **FSL-1.1-ALv2** — хаб (`server-rs/`: команды и роли, видимость для руководителя, аудит, доступ поддержки, шлюз, внешняя редакция), `deploy/selfhost/`, `deploy/sandbox/`. Можно использовать, менять и разворачивать у себя для своей команды, внедрять клиенту, который запускает сам. Нельзя предлагать это другим как конкурирующий продукт или сервис. Через два года каждая версия становится Apache-2.0.

Имя «Hegai Code» и логотипы лицензией не передаются: форк должен называться иначе. Hegai Code работает с Claude Code и OpenAI Codex и не связан с Anthropic или OpenAI.

## English

**Hegai Code** is a central service that shows and controls your **Claude Code** and **OpenAI Codex** sessions across all your machines — from a browser, native iOS/Android apps, a desktop shell (Windows/macOS) and Telegram. Sessions and files stay on your machines; the hub routes control and keeps a catalog and transcript replicas.

- **Editions.** One codebase. The *external* edition is the self-hosted one: you run the hub (`docker compose`), sign in with a local owner account (password + authenticator code) or your OIDC provider, and agents update only to releases that carry our signature **and** that your owner approved with an authenticator code. We have no access to your installation unless your owner grants temporary, logged support access.
- **Try it locally.** The installer needs a public domain (agents use `wss://`; Caddy's `localhost` CA is not trusted by them). Without a server, run the hub and an agent from source: see "Попробовать локально" above or [CONTRIBUTING.md](CONTRIBUTING.md).
- **Optional vendor addresses.** Push notifications and desktop-app downloads need `CC_REMOTE_PUSH_RELAY_URL` and `CC_REMOTE_APP_DL` from the vendor (info@heg.ai); everything else works without them.
- **Quick start.** `deploy/selfhost/README.md` (Russian): `sudo ./install.sh <domain> <owner-email>` writes `.env`, builds and starts the hub, connects the server itself as the owner's machine and prints the one-time setup link; connect other machines with `curl -fsSL https://<domain>/go | bash`.
- **Architecture.** Per-machine agent daemon → hub (Rust/axum, the only listener; agents dial out) → clients (web, iOS, Android, desktop shell, Telegram). One writer per session. Wire schemas in `shared/`. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **Security.** Agents dial out only; releases are Ed25519-signed by a separate signer service and approved by your owner; support access is opt-in, time-boxed and audited. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
- **License.** Split by directory (see [LICENSE](LICENSE)): Apache-2.0 for the agent, protocol, clients, signer and installers; FSL-1.1-ALv2 for the hub (`server-rs/`), `deploy/selfhost/` and `deploy/sandbox/` — free to use and self-host, no Competing Use, each version becomes Apache-2.0 after two years. The "Hegai Code" name and logos are not licensed.
