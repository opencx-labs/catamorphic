-- Seed a default tenant used by the playground when there is no auth
INSERT INTO tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Playground')
ON CONFLICT (id) DO NOTHING;
