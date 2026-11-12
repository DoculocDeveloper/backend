-- Seed or update admin user: lucas@doculoc.com.br
INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "createdAt", "updatedAt")
VALUES (
    'a1b2c3d4-e5f6-4a5b-8c7d-9e0f1a2b3c4d',
    'Lucas',
    'lucas@doculoc.com.br',
    '$2a$10$y6nyMiRYNRbiQgKuUzcbOuI4l8PoGeG/2ksz7kS7XSEdnA6FuzwJ.',
    'ADMIN'::"UserRole",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("email") DO UPDATE SET
    "name" = 'Lucas',
    "passwordHash" = '$2a$10$y6nyMiRYNRbiQgKuUzcbOuI4l8PoGeG/2ksz7kS7XSEdnA6FuzwJ.',
    "role" = 'ADMIN'::"UserRole",
    "updatedAt" = CURRENT_TIMESTAMP;
