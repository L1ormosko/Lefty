-- CreateEnum
CREATE TYPE "LocationTag" AS ENUM ('CITY_CENTER', 'MALL', 'HIGHWAY', 'MAIN_ROAD', 'INDUSTRIAL', 'RESIDENTIAL', 'TRANSIT_HUB', 'EDUCATION', 'HOSPITAL', 'STADIUM', 'BEACH');

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "locationTags" "LocationTag"[];
