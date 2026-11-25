# Песочницы сообщества

Песочница — обычный Linux-пользователь `sb-<slug>` на нашем хосте (сейчас
**stage**, 198.51.100.203) со своим агентом Hegai Code, Claude Code и Codex.
Модели — свои: с 22.09.2026 участник входит своим аккаунтом, с 24.09.2026 —
кнопкой «Войти» на «Настройки → Начало» (Codex выдаёт device-код, Claude —
страницу и код обратно; терминал не нужен). До входа карточка машины говорит
«нет входа». Claude в песочнице разрешён с 24.09.2026 — хаб больше не пинит
песочницу на Codex; `claude` для терминала — симлинк `~/.local/bin/claude` на
бандловый бинарь агента (ставит провижинер).
Песочницы, выданные раньше, ходят через шлюз HegAI по seat'у из
`config.toml` — у них чип «Codex · шлюз example.org». Чудес нет: сессия участника —
процесс Codex в папке `~/work/<проект>`,
а вкладка code.example.com — пульт к нему. Машина принадлежит участнику (он сам
обменял код регистрации на device token), у него полный контроль: терминал,
файлы, git — **в пределах своего home**.

Граница — unix-пользователь, и только она: группа `sandbox`, home `700`, без
sudo и docker, ssh для группы закрыт (`DenyGroups sandbox`), процессы в
cgroup с потолком. Это не виртуалка.

## Лимиты

| Что | Значение | Где |
|---|---|---|
| Память одной песочницы | 1.5 GB мягко, 2 GB жёстко | `cc-remote-sandbox@.service` |
| CPU одной | 1.5 ядра | там же |
| Процессов | 512 | там же |
| Все песочницы вместе | 5 GB мягко, 6 GB жёстко, 4 ядра | `sandboxes.slice` |
| Диск | квот нет (root без `usrquota`); `sb-monitor.sh` ругается с 10 GB на home | — |
| Модели | свои — подписка участника (`codex login --device-auth` в терминале); у песочниц до 22.09.2026 — ключ шлюза из шаблона `hegai:template-community` (токены/запросы в окно) | подписка участника / Bifrost на хабе |

На stage свободно ~8 GB из 24 — это 3–5 песочниц, работающих **одновременно**
(простаивающий агент ~100 MB).

## Согласие участника (текст для приветствия и `/access`)

- Администратор хоста технически может прочитать всё в песочнице — как и на
  любом сервере, которым управляет кто-то другой.
- Транскрипты сессий реплицируются на хаб (code.example.com) — это и есть
  продукт.
- Не храни в песочнице секреты: токены прода, ключи, пароли. Понадобится
  токен для пуша — введи его в терминале, не клади в файлы.
- Код — в git, в свой репозиторий. Бэкапов нет; единственный архив делается
  при удалении песочницы и живёт в `/var/backups/sandboxes/` на хосте.
- Песочницу можно попросить удалить в любой момент; проект твой, а не наш.

## Добавить песочницу руками (`provisioner.mjs local`)

Обычный путь — автоматический: активация в `/w/admin` ставит задачу
`sandbox_create` в очередь хаба, демон `cc-remote-provisioner` забирает её,
код регистрации хаб чеканит в момент выдачи. `local` — запасной: починить
песочницу после `failed`, или хост без демона. Тогда код регистрации
выпускает **сам участник**: Настройки → «Подключить машину» → 15-минутный код
(устройство становится собственностью того, кто выпустил код — Владелец из
своего аккаунта не может). Ключ шлюза при активации создаёт сам хаб
(`hegai:<email>` из шаблона); руками — только если хаб без `LLM_GATEWAY_URL`
или место надо починить, на хаб-боксе:

```bash
/opt/llmgw/provision-seats.sh --template hegai:template-community \
  --description 'Community seat {email}' anna@example.com
```

`gateway.baseUrl` хаб берёт из `LLM_PUBLIC_URL`; встроенного адреса у
провижонера нет (запасной — `SANDBOX_GATEWAY_URL`, иначе задача с ключом без
адреса падает). Затем на stage, `job.json` (никогда не коммитить и не оставлять в истории
шелла — в нём код и ключ):

```json
{
  "kind": "sandbox_create",
  "user": { "userId": "u_123", "email": "anna@example.com", "fullName": "Анна Иванова" },
  "sandbox": { "unixUser": "sb-anna", "machineName": "sb-anna" },
  "enrollment": { "code": "<код из Настроек участника>", "expiresAt": "2026-09-02T12:15:00Z" },
  "gateway": { "baseUrl": "https://llm.example.com/v1", "apiKey": "sk-bf-…", "model": "gpt-5.6-sol" },
  "hub": { "centralUrl": "wss://code.example.com" }
}
```

```bash
set -a; . /etc/cc-remote/provisioner.env; set +a
node /opt/cc-remote-agent/sandbox/provisioner.mjs local job.json && shred -u job.json
```

Результат — JSON `{ok:true, machineId, …}`; машина `sb-anna` появляется у
участницы в «Моей работе» в течение минуты. Шаги идемпотентны: повторный
запуск чинит недостающее и не трогает `agent.json`. Не успел за 120 с —
`{ok:false, stage:"enroll", journalTail}`; новый код — и снова `local`.

Остальные виды: `"kind": "sandbox_suspend" | "sandbox_resume" | "sandbox_delete" | "sandbox_rotate_key"`
с тем же `sandbox.unixUser` (для `rotate_key` — плюс `gateway.apiKey`).

## Эксплуатация

```bash
# обновить агент всем (тянет /install/agent.mjs хаба, ставит deps под /usr/bin/node,
# переключает current, рестартует юниты с паузой 2 с)
/opt/cc-remote-agent/sandbox/sb-agent-update.sh

# состояние
systemctl list-units 'cc-remote-sandbox@*'
systemd-cgtop -b -n1 -m sandboxes.slice
journalctl -fu cc-remote-sandbox@sb-anna
journalctl -fu cc-remote-provisioner

# приостановить / вернуть / удалить (через провижионер — он же снимает юнит,
# блокирует пользователя, для delete делает архив и userdel -r)
node /opt/cc-remote-agent/sandbox/provisioner.mjs local suspend.json

# монитор в Telegram: каждые 5 мин при проблемах, раз в день — сводка
*/5 * * * * /opt/cc-remote-agent/sandbox/sb-monitor.sh >> /var/log/sb-monitor.log 2>&1
0 9 * * *   /opt/cc-remote-agent/sandbox/sb-monitor.sh --daily >> /var/log/sb-monitor.log 2>&1
```

Демон: `cc-remote-provisioner.service` (root, env в
`/etc/cc-remote/provisioner.env` 0600, токен класса provisioner — не флот).
Он только дозванивается до хаба: claim → job → heartbeat каждые 30 с →
result. Один job за раз. В журнале — шаги без секретов.

Опциональные ужесточения `install-host.sh`: `--egress` (nftables рядом с
ufw: наружу только 22/80/443/53, почтовые порты закрыты) и `--hidepid`
(`/proc` с `hidepid=2`; **сначала проверить**, что pm2/hegai не читает чужие
`/proc`; кому надо видеть всех — группа `proc-readers`).

## День раздачи доступов

1. Накануне: `sb-agent-update.sh`, `systemctl status cc-remote-provisioner`,
   `free -m`, `df -h /home`. Шаблон `hegai:template-community` и его
   `/v1/models` — только если кому-то из старых раздаёте seat; новым он не
   нужен, у них свой логин.
2. Активация в `/w/team/access` по одному адресу: смотреть
   `journalctl -fu cc-remote-provisioner` — каждая задача кончается строкой
   `step=done ok machineId=…` за 1–3 минуты.
3. `stage=enroll` с `retryable:true` — обычно код истёк (15 мин) или агент не
   поднялся; хаб повторит с новым кодом до 3 раз. Повторно `failed` — смотреть
   `journalTail` в админке, чинить руками через `local`.
4. После раздачи: `sb-monitor.sh --daily`, `free -m` при живых сессиях, через
   неделю сверить расход ключей с лимитами шаблона.

## Когда переезжать на отдельный VPS

Любое из: больше ~8 участников на stage; `sb-monitor` регулярно видит
`MemAvailable` < 1.5 GB или троттлинг слайса при 3+ живых сессиях; нужны
превью-порты наружу (stage закрыт) или дисковые квоты (`usrquota` = ребут
ops-бокса). Переезд — тот же `install-host.sh` на новом хосте
(`sb1`, 8 vCPU / 32 GB / 400 GB) с другим `SANDBOX_HOST`; хаб маршрутизирует
задачи по имени хоста, дизайн не меняется.

## Превью: показать то, что запустил

У песочницы есть публичный адрес для dev-сервера. Слот выдаётся по uid, поэтому
он стабильный и ничего нигде не записывается:

| uid | порт | адрес |
|---|---|---|
| 20000 | 3110 | https://preview-sb1.example.com |
| 20001 | 3111 | https://preview-sb2.example.com |
| 20002 | 3112 | https://preview-sb3.example.com |

Порт лежит в `~/.cc-remote/env` и в `~/.profile` как `PORT`, адрес — как
`HEGAI_PREVIEW_URL`. Next и Vite читают `PORT` сами, так что `next dev` без
флагов уже попадает куда надо; Vite дополнительно требует адрес в
`server.allowedHosts`. Сервер должен слушать `127.0.0.1` — наружу порт не
открыт, наружу его выносит обратный туннель `preview-tunnel.service` на хаб.

Пул маленький намеренно: на этом боксе всё равно живёт 3–5 песочниц.
Четвёртая и дальше работают полностью, просто их dev-сервер не публикуется.
Порты 3100–3106 раньше занимал контур превью проектов сотрудников; 14.09.2026
он снесён целиком (у сотрудника пуш в главную ветку выкатывается на боевой
автодеплоем, промежуточный стенд не нужен), так что пул свободен.
Расширять — добавить порты в `-R` туннеля, в
`permitlisten` ключа previewtun на хабе, записи DNS и имена в
`/etc/nginx/sites-available/preview-sandboxes.example.com` (сертификат
`preview-sandboxes` выпускается через HTTP-01, `--cert-name preview-sandboxes`).

**Адрес публичный.** Кто знает ссылку, тот видит страницу: это витрина, а не
место для данных. Так и написано на заглушке, когда сервер не запущен.


## Agent updates follow hub deploys (24.09.2026)

`sb-agent-autoupdate.sh` (cron `*/5`, `/etc/cron.d/sb-agent-autoupdate`, installed
by `install-host.sh`) compares the hub's `/install/agent.mjs.sha256` with
`current`, runs `sb-agent-update.sh --no-restart` when they differ, then restarts
every `cc-remote-sandbox@*` unit that started before the flip — one at a time,
and only when that sandbox has no busy/waiting Claude child and no Codex rollout
written in the last 10 minutes. A busy sandbox waits for a later tick. Log:
`/var/log/sb-agent-autoupdate.log`. The sandbox agent's own self-update is off
by design (it cannot write the shared release) and says so once at start.

## Личная песочница сотрудника (с 24.11.2026, первая — `sb-yulia`)

Хаб песочницы больше не раздаёт (`CC_REMOTE_SANDBOX_ERASURE_ONLY=1`), поэтому сотруднику
её заводят руками через `provisioner.mjs local`. Код регистрации участнику выпускать не
нужно: root вставляет строку в `enrollments` хаба (`purpose='sandbox'`, `code_hash` =
sha256 кода, срок 15 мин, `user_id` сотрудника), так что машина сразу принадлежит ему и
видна только ему. В `job.json` — ключ шлюза (`gateway`), как у devbox.

Сверху штатной песочницы (`sb-*` не видит локальных портов чужих сервисов, только 22/80/443 наружу):
- **админка платформы от имени сотрудника** — `~/.config/hegai/admin-token` (кука `auth-token`,
  14 дней). Выписывает `/usr/local/sbin/hegai-employee-admin-token <unix>` (ssh prod → jose,
  проверяет, что пользователь — активный админ), user_id — `/etc/hegai-employee-admin/<unix>`,
  перевыпуск — `hegai-employee-admin-token@<unix>.timer` (пн). Отзыв: выключить таймер и
  удалить файл; мгновенно — снять роль админа на платформе. Клиент — `~/.local/bin/hegai-admin`
  (ставит `Origin: https://admin.example.com`, иначе CSRF-гейт отбивает POST);
- **прод-база на чтение** — `~/.local/bin/prod-db`: свой `ssh -L 127.0.0.1:25432` к
  `devbox_tunnel@prod` (ключ `hegai_db_ro`, роль `devbox_ro`), туннель общего devbox на :15432
  из `sandboxes.slice` недоступен by design;
- **git** — свой пользователь Forgejo (`yulia`, write на нужные репо, токен в
  `~/.config/forgejo/token`), выкатка платформы всё равно только кнопкой Владельца;
- правила агента — `~/.codex/AGENTS.md` и `~/.claude/CLAUDE.md` песочницы.

