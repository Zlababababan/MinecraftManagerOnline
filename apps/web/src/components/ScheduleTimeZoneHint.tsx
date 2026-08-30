/**
 * Rappelle, à l'endroit exact où l'on saisit une heure, dans quel fuseau elle sera lue.
 *
 * Silencieux quand le navigateur et le panel affichent la même heure — l'immense majorité des
 * cas. Il ne parle que lorsqu'il y a un écart, c'est-à-dire lorsqu'une sauvegarde réglée sur 4 h
 * partirait à une autre heure que celle attendue.
 */
import { Text } from '@mantine/core';

import { useMe } from '../api/queries.js';
import { useT } from '../i18n/hooks.js';
import { timeZoneNotice } from '../lib/schedule-timezone.js';

export function ScheduleTimeZoneHint({ testId = 'schedule-tz' }: { testId?: string }) {
  const { t } = useT();
  const me = useMe();
  const notice = timeZoneNotice(me.data?.scheduleTimezone);
  if (!notice) return null;
  return (
    <Text size="xs" c={notice.matchesBrowser ? 'dimmed' : 'orange'} data-testid={testId}>
      {notice.matchesBrowser
        ? t('web:schedule.timezone.same', { zone: notice.label })
        : t('web:schedule.timezone.differs', {
            zone: notice.label,
            browser: notice.browserLabel,
          })}
    </Text>
  );
}
