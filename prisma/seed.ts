import { PrismaClient, UserRole, UserStatus } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Seeding database...');

  const passwordHash = await bcrypt.hash('123456', 10);

  const users = [
    {
      email: 'superadmin@gmail.com',
      fullName: 'Super Admin',
      passwordHash,
      role: UserRole.super_admin,
      status: UserStatus.active,
      phone: '+10000000001',
    },
  ];

  for (const user of users) {
    const existing = await prisma.user.findUnique({
      where: { email: user.email },
    });

    if (!existing) {
      await prisma.user.create({
        data: user,
      });
      console.log(`✅ Created ${user.role}: ${user.email}`);
    } else {
      await prisma.user.update({
        where: { email: user.email },
        data: {
          passwordHash,
          role: user.role,
          status: user.status,
        },
      });
      console.log(`🔄 Updated ${user.role}: ${user.email}`);
    }
  }

  console.log('🎉 Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
