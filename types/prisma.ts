// types/prisma.ts
import { Game, User } from '@prisma/client';

export interface GameWithUser extends Game {
  user: User;
}
