/*
  Warnings:

  - You are about to drop the column `createdAt` on the `Game` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `User` table. All the data in the column will be lost.
  - Added the required column `img_icon_url` to the `Game` table without a default value. This is not possible if the table is not empty.
  - Added the required column `playtime_forever` to the `Game` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX `Game_appid_userId_key` ON `Game`;

-- AlterTable
ALTER TABLE `Game` DROP COLUMN `createdAt`,
    ADD COLUMN `img_icon_url` VARCHAR(191) NOT NULL,
    ADD COLUMN `playtime_forever` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `User` DROP COLUMN `createdAt`;
