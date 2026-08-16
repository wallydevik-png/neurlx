DELETE FROM public.notifications
WHERE kind = 'model.retrained'
  AND id NOT IN (
    SELECT id FROM public.notifications WHERE kind = 'model.retrained'
    ORDER BY created_at DESC LIMIT 1
  );