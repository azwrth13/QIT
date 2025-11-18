// lib/prisma.ts
import { PrismaClient } from '@prisma/client';

declare global {
  // Prevent multiple instances of PrismaClient in development
  var prisma: PrismaClient | undefined;
}

const prisma = global.prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' 
    ? ['info', 'warn', 'error'] // Development: info, warnings, and errors (no query logging)
    : ['warn', 'error'], // Production: only warnings and errors
});

if (process.env.NODE_ENV !== 'production') global.prisma = prisma;

export default prisma;
