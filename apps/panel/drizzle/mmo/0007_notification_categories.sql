-- Séparation de la catégorie `resources` en `resource.disk` et `resource.tps` : un disque plein et
-- un TPS effondré n'appellent pas la même réaction, et l'utilisateur doit pouvoir n'en garder
-- qu'un. Le choix déjà exprimé est reporté sur les deux nouvelles clés (surtout un « non » : il
-- serait très désagréable qu'une catégorie coupée se rallume toute seule à la mise à jour).
INSERT OR IGNORE INTO notification_prefs (user_id, event_type, enabled)
SELECT user_id, 'resource.disk', enabled FROM notification_prefs WHERE event_type = 'resources';
--> statement-breakpoint
INSERT OR IGNORE INTO notification_prefs (user_id, event_type, enabled)
SELECT user_id, 'resource.tps', enabled FROM notification_prefs WHERE event_type = 'resources';
--> statement-breakpoint
DELETE FROM notification_prefs WHERE event_type = 'resources';
