import type { GithubGrant } from '@cc-remote/shared';

/** Where the invitation to the private repository stands: the hub invites the
 *  person's GitHub account when an admin activates them (github_grant.rs). */
export function RepoGrantCard({ grant }: { grant: GithubGrant }) {
  if (grant.status === 'revoking' || grant.status === 'revoked') return null;
  const url = `https://github.com/${grant.repo}`;
  return (
    <section className="team-card settings-section repo-grant">
      <h3>Репозиторий с кодом</h3>
      {grant.status === 'invited' && (
        <p className="team-help">
          Приглашение в репозиторий <b>{grant.repo}</b> отправлено — примите его на GitHub:{' '}
          <a href={`${url}/invitations`} target="_blank" rel="noreferrer">открыть приглашение</a>.
        </p>
      )}
      {grant.status === 'granted' && (
        <p className="team-help">
          Доступ к репозиторию <b>{grant.repo}</b> открыт: <a href={url} target="_blank" rel="noreferrer">github.com/{grant.repo}</a>.
        </p>
      )}
      {grant.status === 'pending' && (
        <p className="team-help">Готовим приглашение в репозиторий <b>{grant.repo}</b> — оно придёт на ваш GitHub в ближайшие минуты.</p>
      )}
      {grant.status === 'failed' && (
        <p className="team-help">Не получилось пригласить вас в репозиторий <b>{grant.repo}</b>. Администратор уже видит ошибку и повторит попытку.</p>
      )}
    </section>
  );
}
