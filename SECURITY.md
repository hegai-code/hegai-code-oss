# Политика безопасности / Security policy

## Как сообщить об уязвимости

**Не открывайте публичный issue.** Напишите на **info@heg.ai** с темой «Security: Hegai Code». По возможности приложите:

- версию (`agent/package.json`, коммит), редакцию (внутренняя / внешняя);
- шаги воспроизведения или proof of concept, ожидаемый и фактический результат;
- последствия: какие данные или права получает атакующий.

Мы подтвердим получение в течение 3 рабочих дней, сообщим оценку и срок исправления, а после выпуска исправления согласуем с вами публикацию и, если вы хотите, укажем ваше имя. Не нужно ни проверять уязвимость на чужих установках, ни получать доступ к данным других людей — достаточно доказать проблему на своей.

## What is in scope

In scope (the external, self-hosted edition and the code in this repository):

- **Hub (`server-rs/`)**: authentication and sessions (local owner sign-in, authenticator codes and recovery codes, OIDC, Google/Telegram sign-in), the access gates (`require_active`, team/role/project checks), the single-writer lock, rate limiting and the trusted-proxy rule for `X-Real-IP`, support-access grants and their audit log.
- **Release chain**: the signed agent release (`deploy/release-signer/`, `deploy/release-keys.txt`, manifest and signature verification in the hub and the agent, owner approval, first-boot rule, rollback), anything that lets an unsigned, wrongly signed or wrong-edition bundle be offered, approved or installed.
- **Agent (`agent/`)**: the dial-out channel and credentials, file/git/terminal RPC confinement, secret masking, self-update.
- **Clients** (`web/`, `ios/`, `android/`, `windows/`, `tgbot/`): token and cookie handling, XSS/CSRF, deep links, the desktop shell's updater.
- **Deployment kit (`deploy/selfhost/`)**: defaults that weaken the container or the proxy.

Out of scope: findings that need root or a malicious operator on the customer's own server (the operator is trusted), missing hardening on a host you configured differently from `deploy/selfhost/`, denial of service by volume alone, social engineering, and vulnerabilities in third-party dependencies without a demonstrated impact on Hegai Code (report those upstream; we track advisories with `npm audit` and `cargo audit`).

Known and documented limits are listed in [docs/EXTERNAL-EDITION.md](docs/EXTERNAL-EDITION.md) ("Honest limits"); a report that restates one of them is welcome as a suggestion but is not a vulnerability.

## Supported versions

Only the latest release of the external edition receives security fixes.
