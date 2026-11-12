import { prisma } from "../lib/prisma.js";
import bcrypt from "bcryptjs";
import { UserRole } from "../domain/roles.js";

async function main() {
  const email = "lucas@doculoc.com.br";
  const name = "Lucas";
  const rawPassword = "Doculoc2026!";
  const passwordHash = await bcrypt.hash(rawPassword, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      name,
      role: UserRole.ADMIN,
      passwordHash,
    },
    create: {
      name,
      email,
      role: UserRole.ADMIN,
      passwordHash,
    },
  });

  console.log(`✅ Usuário administrador garantido com sucesso!`);
  console.log(`   ID: ${user.id}`);
  console.log(`   Nome: ${user.name}`);
  console.log(`   E-mail: ${user.email}`);
  console.log(`   Perfil: ${user.role}`);
}

main()
  .catch((err) => {
    console.error("Erro ao executar seed de admin:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
