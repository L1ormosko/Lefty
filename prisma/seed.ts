/**
 * Demo seed.
 *
 * Everything created here is flagged isDemo: true. These are NOT real
 * commercial listings - the UI labels them as development/demo records.
 *
 * Two things about this file are easy to forget and were both true at once:
 * the repository is public, and the deploy's build command ends with
 * `npm run seed:dev`. So a password written here was a working ADMIN login for
 * the live site, published on GitHub. That is not hypothetical - it was the
 * case until this change, and the credential has since been rotated.
 *
 * Hence no credential lives here any more, and there is no fallback - a
 * fallback is exactly how that hole comes back quietly. See DECISIONS.md 16.
 */
import { PrismaClient, type AssetType, type Illumination } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { demoImage } from "./demo-image";
import { demoSeedEnabled, requireSeedPassword } from "./seed-config";

const prisma = new PrismaClient();

function d(iso: string) {
  return new Date(`${iso}T00:00:00.000Z`);
}
function daysFromNow(n: number) {
  const t = new Date();
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCDate(t.getUTCDate() + n);
  return t;
}

type AssetSeed = {
  title: string;
  assetType: AssetType;
  address: string;
  city: string;
  region: string;
  lat: number;
  lng: number;
  w?: number;
  h?: number;
  sides?: number;
  illumination?: Illumination;
  isDigital?: boolean;
  priceWeekly?: number | null;
  priceMonthly?: number | null;
  minDays?: number;
  verification: "PENDING" | "VERIFIED" | "REJECTED";
  status?: "ACTIVE" | "INACTIVE" | "DRAFT";
  instantBookable?: boolean;
  description?: string;
};

// Coordinates are approximate street locations used for development only.
const BEER_SHEVA: AssetSeed[] = [
  {
    title: "שלט חוצות — כניסה לעיר, דרך חברון",
    assetType: "BILLBOARD",
    address: "דרך חברון 1",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2412,
    lng: 34.7965,
    w: 900, h: 300, sides: 2, illumination: "FRONTLIT",
    priceWeekly: 3200, priceMonthly: 11000, minDays: 14,
    verification: "VERIFIED",
    description: "שלט דו־צדדי בציר תנועה ראשי בכניסה הצפונית לעיר.",
  },
  {
    title: "מסך דיגיטלי — קניון הנגב",
    assetType: "DIGITAL_BILLBOARD",
    address: "שדרות רגר 43",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2589, lng: 34.7995,
    w: 400, h: 250, illumination: "BACKLIT", isDigital: true,
    priceWeekly: 4500, priceMonthly: 16000, minDays: 7,
    verification: "VERIFIED", instantBookable: true,
    description: "מסך LED בכניסה הראשית לקניון. לולאת שידור משותפת.",
  },
  {
    title: "קיר פרסום — העיר העתיקה",
    assetType: "WALL",
    address: "רחוב הרצל 62",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2432, lng: 34.7907,
    w: 600, h: 400, illumination: "NONE",
    priceWeekly: null, priceMonthly: 4800, minDays: 30,
    verification: "VERIFIED",
    description: "קיר בעיר העתיקה, חשיפה להולכי רגל.",
  },
  {
    title: "טוטם — פארק ההייטק",
    assetType: "TOTEM",
    address: "שדרות דוד טוביהו 20",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2646, lng: 34.8095,
    w: 120, h: 300, illumination: "BACKLIT",
    priceWeekly: 1400, priceMonthly: 4900, minDays: 14,
    verification: "VERIFIED",
  },
  {
    title: "תחנת אוטובוס — אוניברסיטת בן־גוריון",
    assetType: "BUS_STOP",
    address: "שדרות בן־גוריון 100",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2620, lng: 34.8010,
    w: 175, h: 118, illumination: "BACKLIT",
    priceWeekly: 900, priceMonthly: 3100, minDays: 14,
    verification: "VERIFIED",
  },
  {
    title: "שלט חוצות — צומת שוק",
    assetType: "BILLBOARD",
    address: "אליהו נאוי 4",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2478, lng: 34.7873,
    w: 600, h: 300, illumination: "NONE",
    priceWeekly: 2100, priceMonthly: 7400, minDays: 14,
    verification: "PENDING",
    description: "דווח ע״י בעל השטח, ממתין לאימות VELTO.",
  },
  {
    title: "באנר — אצטדיון טוטו טרנר",
    assetType: "BANNER",
    address: "רחוב יצחק בן צבי 1",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2381, lng: 34.8103,
    w: 800, h: 200,
    priceWeekly: 1800, priceMonthly: null, minDays: 7,
    verification: "PENDING",
  },
  {
    title: "ריהוט רחוב — שדרות רגר",
    assetType: "STREET_FURNITURE",
    address: "שדרות רגר 100",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2532, lng: 34.7969,
    priceWeekly: null, priceMonthly: null, minDays: 14,
    verification: "VERIFIED",
    description: "המחיר אינו מפורסם. ניתן לבקש הצעת מחיר מבעל השטח.",
  },
  {
    title: "מסך דיגיטלי — רמות",
    assetType: "DIGITAL_BILLBOARD",
    address: "שדרות טוביהו 120",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2755, lng: 34.8218,
    isDigital: true, w: 300, h: 200, illumination: "BACKLIT",
    priceWeekly: 2600, priceMonthly: 9000, minDays: 7,
    verification: "VERIFIED",
  },
  {
    title: "שלט חוצות — יציאה דרומית",
    assetType: "BILLBOARD",
    address: "כביש 40, יציאה דרומית",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2201, lng: 34.7852,
    w: 1200, h: 400, sides: 1,
    priceWeekly: 3900, priceMonthly: 13500, minDays: 14,
    verification: "VERIFIED",
  },
  {
    title: "קיר — אזור תעשייה עמק שרה",
    assetType: "WALL",
    address: "האורגים 12",
    city: "באר שבע",
    region: "דרום",
    lat: 31.2274, lng: 34.7726,
    w: 1000, h: 300,
    priceWeekly: null, priceMonthly: 5200, minDays: 30,
    verification: "VERIFIED", status: "INACTIVE",
  },
];

const REST_OF_ISRAEL: AssetSeed[] = [
  {
    title: "שלט חוצות — איילון דרום",
    assetType: "BILLBOARD",
    address: "נתיבי איילון",
    city: "תל אביב-יפו", region: "מרכז",
    lat: 32.0603, lng: 34.7936,
    w: 1200, h: 400, illumination: "FRONTLIT",
    priceWeekly: 12000, priceMonthly: 42000, minDays: 14,
    verification: "VERIFIED",
  },
  {
    title: "מסך דיגיטלי — הכניסה לירושלים",
    assetType: "DIGITAL_BILLBOARD",
    address: "שדרות הרצל",
    city: "ירושלים", region: "ירושלים",
    lat: 31.7857, lng: 35.2007,
    isDigital: true, w: 500, h: 300, illumination: "BACKLIT",
    priceWeekly: 8000, priceMonthly: 28000, minDays: 7,
    verification: "VERIFIED",
  },
  {
    title: "שלט חוצות — צ׳ק פוסט חיפה",
    assetType: "BILLBOARD",
    address: "דרך יד לבנים",
    city: "חיפה", region: "צפון",
    lat: 32.7940, lng: 35.0410,
    w: 900, h: 300,
    priceWeekly: 5200, priceMonthly: 18000, minDays: 14,
    verification: "VERIFIED",
  },
  {
    title: "טוטם — מרכז אשדוד",
    assetType: "TOTEM",
    address: "רוגוזין 12",
    city: "אשדוד", region: "דרום",
    lat: 31.8014, lng: 34.6553,
    w: 120, h: 300,
    priceWeekly: 1600, priceMonthly: 5600, minDays: 14,
    verification: "PENDING",
  },
  {
    title: "תחנת אוטובוס — מרכז אילת",
    assetType: "BUS_STOP",
    address: "דרך התמרים 5",
    city: "אילת", region: "דרום",
    lat: 29.5570, lng: 34.9520,
    w: 175, h: 118,
    priceWeekly: 1100, priceMonthly: 3800, minDays: 14,
    verification: "VERIFIED",
  },
];

async function main() {
  // The switch that turns demo data off for a real launch: one environment
  // variable rather than a code change, because this seed deletes and recreates
  // the demo rows on every single deploy.
  if (!demoSeedEnabled()) {
    console.log("SEED_DEMO is not \"1\" - skipping demo data entirely.");
    return;
  }

  console.log("Seeding VELTO demo data…");
  const passwordHash = await bcrypt.hash(requireSeedPassword(), 10);

  // Remove previous demo data only. Real records are never touched.
  await prisma.mediaAsset.deleteMany({ where: { isDemo: true } });
  await prisma.company.deleteMany({ where: { isDemo: true } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@velto.dev" } } });

  const ownerCompany = await prisma.company.create({
    data: {
      name: "נגב מדיה בע״מ (הדגמה)",
      type: "MEDIA_OWNER",
      contactEmail: "office@negev-media.velto.dev",
      contactPhone: "08-6000000",
      isDemo: true,
    },
  });
  const ownerCompany2 = await prisma.company.create({
    data: {
      name: "אורבן אאוטדור (הדגמה)",
      type: "MEDIA_OWNER",
      contactEmail: "office@urban-outdoor.velto.dev",
      isDemo: true,
    },
  });
  const advertiserCompany = await prisma.company.create({
    data: {
      name: "סטודיו קמפיין (הדגמה)",
      type: "ADVERTISER",
      contactEmail: "hello@campaign-studio.velto.dev",
      isDemo: true,
    },
  });

  const admin = await prisma.user.create({
    data: { email: "admin@velto.dev", passwordHash, name: "מנהל VELTO", role: "ADMIN" },
  });
  const owner = await prisma.user.create({
    data: {
      email: "owner@velto.dev", passwordHash, name: "דנה לוי", role: "MEDIA_OWNER",
      phone: "050-0000001", companyId: ownerCompany.id,
    },
  });
  const owner2 = await prisma.user.create({
    data: {
      email: "owner2@velto.dev", passwordHash, name: "יוסי כהן", role: "MEDIA_OWNER",
      phone: "050-0000002", companyId: ownerCompany2.id,
    },
  });
  const advertiser = await prisma.user.create({
    data: {
      email: "advertiser@velto.dev", passwordHash, name: "מיכל בר", role: "ADVERTISER",
      phone: "050-0000003", companyId: advertiserCompany.id,
    },
  });

  const created: { id: string; title: string }[] = [];
  const all = [...BEER_SHEVA, ...REST_OF_ISRAEL];
  for (const [i, s] of all.entries()) {
    const useOwner2 = i % 3 === 2;
    const asset = await prisma.mediaAsset.create({
      data: {
        ownerId: useOwner2 ? owner2.id : owner.id,
        companyId: useOwner2 ? ownerCompany2.id : ownerCompany.id,
        title: s.title,
        description: s.description,
        assetType: s.assetType,
        address: s.address,
        city: s.city,
        region: s.region,
        latitude: s.lat,
        longitude: s.lng,
        widthCm: s.w ?? null,
        heightCm: s.h ?? null,
        sides: s.sides ?? 1,
        illumination: s.illumination ?? "UNKNOWN",
        isDigital: s.isDigital ?? s.assetType === "DIGITAL_BILLBOARD",
        status: s.status ?? "ACTIVE",
        verificationStatus: s.verification,
        verifiedAt: s.verification === "VERIFIED" ? new Date() : null,
        verifiedById: s.verification === "VERIFIED" ? admin.id : null,
        permitStatus: "UNKNOWN",
        priceWeekly: s.priceWeekly ?? null,
        priceMonthly: s.priceMonthly ?? null,
        minimumBookingDays: s.minDays ?? 7,
        instantBookable: s.instantBookable ?? false,
        isDemo: true,
        periods: {
          create: [
            { startDate: daysFromNow(0), endDate: daysFromNow(120), note: "חלון זמינות ראשוני" },
            ...(i % 4 === 0
              ? [{ startDate: daysFromNow(150), endDate: daysFromNow(300), note: "עונה נוספת" }]
              : []),
          ],
        },
      },
    });
    // A placeholder picture, so the marketplace does not read as unfinished
    // with every listing showing an empty frame. Deliberately a schematic with
    // "demo image" burned into the bitmap rather than anything resembling a
    // photograph: inventing a picture of a hoarding that does not exist would
    // be fabricating inventory. Written through the same table and encoder the
    // real upload route uses, so there is no second storage path to maintain.
    const imageId = randomUUID();
    const bytes = await demoImage({ assetType: s.assetType, label: asset.title });
    await prisma.$transaction([
      prisma.mediaAssetImage.create({
        data: {
          id: imageId,
          assetId: asset.id,
          url: `/api/images/${imageId}`,
          width: 1200,
          height: 675,
          sizeBytes: bytes.length,
          isPrimary: true,
          sortOrder: 0,
        },
      }),
      prisma.mediaAssetImageBlob.create({
        data: { imageId, data: new Uint8Array(bytes), contentType: "image/webp" },
      }),
    ]);

    created.push({ id: asset.id, title: asset.title });
  }

  // One approved booking so "occupied" and "partial" states are visible on the map.
  const busy = created[0];
  await prisma.booking.create({
    data: {
      assetId: busy.id,
      advertiserId: advertiser.id,
      startDate: daysFromNow(3),
      endDate: daysFromNow(45),
      priceEstimate: 15000,
      status: "APPROVED",
      decidedAt: new Date(),
    },
  });

  const inquiryAsset = created[1];
  const inquiry = await prisma.inquiry.create({
    data: {
      assetId: inquiryAsset.id,
      advertiserId: advertiser.id,
      intent: "AVAILABILITY",
      startDate: daysFromNow(20),
      endDate: daysFromNow(34),
      campaignName: "השקת סניף חדש",
      budget: 20000,
      message: "מעוניינים בשבועיים בחודש הבא. אפשר לקבל זמינות ומחיר?",
      contactName: "מיכל בר",
      contactEmail: "advertiser@velto.dev",
      contactPhone: "050-0000003",
      status: "PENDING",
    },
  });

  await prisma.booking.create({
    data: {
      assetId: created[3].id,
      advertiserId: advertiser.id,
      startDate: daysFromNow(60),
      endDate: daysFromNow(74),
      priceEstimate: 2450,
      status: "REQUESTED",
    },
  });

  await prisma.savedAsset.create({ data: { userId: advertiser.id, assetId: created[2].id } });

  await prisma.notification.create({
    data: {
      userId: owner.id,
      type: "INQUIRY_CREATED",
      title: `פנייה חדשה: ${inquiryAsset.title}`,
      linkUrl: "/owner/inquiries",
    },
  });

  console.log(`Created ${created.length} demo assets, 4 users.`);
  // The password is deliberately not printed. Build logs are retained and
  // readable in the hosting dashboard; echoing the credential there would
  // undo half the point of moving it out of the file.
  console.log("Demo logins (password: the SEED_PASSWORD value for this environment):");
  for (const email of ["admin@velto.dev", "owner@velto.dev", "owner2@velto.dev", "advertiser@velto.dev"]) {
    console.log(`  ${email}`);
  }
  console.log(`Inquiry seeded: ${inquiry.id}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
