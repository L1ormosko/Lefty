/**
 * Every user-facing string lives here, keyed by locale.
 * Hebrew is the launch locale; the shape is ready for "en" without touching
 * component code (see t()).
 */
import type { AvailabilityState } from "./constants";

export const LOCALES = ["he", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "he";

type Dict = Record<string, string>;

const he: Dict = {
  "app.name": "VELTO",
  "app.tagline": "שטחי פרסום חוץ בישראל — חיפוש, השוואה ובקשת זמינות",
  // Shown in the thin bar above the map, so it has to survive truncation.
  "home.headline": "שטחי פרסום חוץ בישראל — מה פנוי, ומתי",
  "home.sub": "סננו לפי עיר, סוג ותאריכים, ופנו ישירות לבעל השטח.",

  "landing.title": "VELTO",
  // "שוק שטחי הפרסום חוץ של ישראל" claimed to *be* the market. We are a pilot
  // in one city with a national map, and the product's own rule is not to
  // claim what it cannot show.
  "landing.eyebrow": "מפה ארצית · פיילוט מסחרי בבאר שבע",
  // Three words, and they are the exact question a media buyer picks up the
  // phone to ask ten owners. "On one map" was in here and is format, not the
  // promise - it moved to the subheadline, which also fixed a wrap that left
  // the em dash orphaned at the start of line two.
  "landing.headline": "מה פנוי, איפה ומתי",
  "landing.sub": "שלטי חוצות, מסכים דיגיטליים, קירות וטוטמים — על מפה אחת, עם התאריכים שבהם כל שטח באמת פנוי. סננו לפי עיר, תאריך ותקציב, ופנו ישירות לבעל השטח.",
  "landing.ctaExplore": "ראו מה פנוי במפה",
  "landing.ctaOwner": "פרסמו את השטח שלכם",

  "landing.coverageTitle": "מלאי פעיל",
  "landing.coverageNote": "{assets} שטחים ב-{cities} ערים",
  "landing.coverageEmpty": "VELTO בהרצה. המלאי המסחרי הראשון נבנה כרגע בבאר שבע — במפה מוצגים בינתיים שטחי הדגמה, מסומנים ככאלה.",

  // Was "one platform, two sides" over a paragraph of company language
  // ("neutral intermediary"). The same fact, said as what it means for them.
  "landing.sidesTitle": "אנחנו לא לוקחים נתח מהעסקה",
  "landing.sidesBody": "VELTO לא מחזיקה שטחי פרסום ולא סוגרת עסקאות. אנחנו מראים מה קיים ומתי הוא פנוי — המחיר, המשא ומתן והסגירה נשארים בינכם לבין בעל השטח.",

  "landing.howTitle": "איך זה עובד",
  "landing.advertiserTitle": "למפרסמים ולמשרדי פרסום",
  "landing.advertiserStep1Title": "חיפוש על המפה",
  "landing.advertiserStep1Body": "סננו לפי עיר, סוג שטח, תאריכים, תקציב, דיגיטלי או מאומתים בלבד — ותראו רק שטחים שקיימים במאגר.",
  "landing.advertiserStep2Title": "בדיקת זמינות ומחיר",
  "landing.advertiserStep2Body": "שלחו בקשת זמינות, הצעת מחיר או בקשת הזמנה ישירות לבעל השטח. המחיר נקבע על ידו, לא על ידי VELTO.",
  "landing.advertiserStep3Title": "מעקב אחרי הבקשה",
  "landing.advertiserStep3Body": "כל הבקשות, ההזמנות והשטחים ששמרתם — במקום אחד, באזור האישי.",
  "landing.ownerTitle": "לבעלי שטחי פרסום",
  "landing.ownerStep1Title": "פרסום השטח",
  "landing.ownerStep1Body": "מיקום, מפרט, תמונות ומחיר. שדות שלא מולאו יוצגו כ״לא צוין״ — איננו ממציאים נתונים בשמכם.",
  "landing.ownerStep2Title": "אימות מול VELTO",
  "landing.ownerStep2Body": "צוות VELTO בודק את השטח לפני שהוא מסומן כמאומת. עד אז הוא מוצג כ״ממתין לאימות״ — לא מוסתר, אבל גם לא מתחזה.",
  "landing.ownerStep3Title": "קבלת פניות",
  "landing.ownerStep3Body": "בקשות והזמנות מגיעות אליכם ישירות. אתם מאשרים, דוחים או משיבים — הקשר עם המפרסם נשאר בידיכם.",

  "landing.mapTitle": "מה יש במפה",
  "landing.mapFeature1": "סינון לפי עיר וסוג שטח — שלט חוצות, מסך דיגיטלי, קיר, טוטם, תחנת אוטובוס ועוד.",
  "landing.mapFeature2": "בדיקת זמינות לפי תאריכי הקמפיין שלכם, ולא רק ״פנוי/תפוס״ כללי.",
  "landing.mapFeature3": "טווח מחירים, וסינון ל״דיגיטלי בלבד״ או ״מאומתים בלבד״.",
  "landing.mapFeature4": "לכל שטח: מפרט, תמונות, סטטוס אימות וסטטוס זמינות.",
  "landing.mapFeature5": "שמירת שטחים לרשימה, להשוואה מאוחר יותר.",
  "landing.mapFeature6": "אזור אישי לשני הצדדים — למפרסמים ולבעלי השטחים.",

  "landing.trustTitle": "שקיפות היא לא סלוגן — היא איך שהמערכת בנויה",
  /*
   * This used to open with "VELTO is a new platform, we have no customers or
   * testimonials to show" - leading with the weakness and asking to be
   * forgiven for it. The same fact is a stronger claim said forward, and it is
   * checkable: the US has Geopath and the UK has Route, independent industry
   * measurement bodies that publish their methodology. Market research for
   * this project found no Israeli equivalent - the one public methodology
   * belongs to a single vendor and is not audited. So "we quote no impression
   * numbers" is not modesty, it is the only honest option available here, and
   * saying so is worth more than a logo wall we do not have.
   */
  "landing.trustIntro": "בפרסום חוץ נהוג לצטט מספרי חשיפה. בארה״ב ובבריטניה יש ועדות מדידה עצמאיות שעומדות מאחורי המספרים האלה; בישראל אין מקבילה — ולכן לא תמצאו כאן אף מספר חשיפה. מה שתמצאו: מה שבעל השטח הצהיר, מתי אומת, ומה עדיין לא ידוע.",
  "landing.trustPoint1": "סטטוס אימות גלוי לכל שטח — מאומת, ממתין לאימות או נדחה. שטח שלא אומת אינו מוסתר, אבל גם אינו מוצג כאילו אומת.",
  "landing.trustPoint2": "שדה שלא מולא מוצג כ״לא צוין״ — לא כמספר גנרי ולא כברירת מחדל מייפה.",
  "landing.trustPoint3": "המחיר, אם פורסם, הוא המחיר שבעל השטח קבע. אם לא פורסם — אפשר לבקש הצעת מחיר ישירה.",
  "landing.trustPoint4": "סטטוס רישוי מדווח על ידי בעל השטח בלבד. VELTO אינה מאשרת ואינה שוללת חוקיות שילוט.",
  "landing.trustPoint5": "שטחי הדגמה, ככל שמוצגים, מסומנים בבירור ואינם מלאי מסחרי.",
  "landing.trustClosing": "איננו מתחייבים על מה שאין לנו. אנחנו מתחייבים על מה שכתוב — ומה שכתוב הוא מה שיש.",

  "landing.audienceAdvertiser": "למשרדי פרסום ולמפרסמים ישירים: מקום אחד לבדוק זמינות אמיתית לפני שמרימים טלפון.",
  "landing.audienceOwner": "לבעלי שטח עצמאיים ולחברות שילוט: ערוץ ישיר לפניות, בלי לוותר על נתח לגורם מתווך.",

  // "Ready to get started?" asks nothing. This asks the one question the
  // headline promised to answer, which is also the reason to click.
  "landing.footerCta": "מה פנוי אצלכם בעיר?",
  "landing.footerLogin": "יש לכם כבר חשבון?",

  "legal.terms": "תקנון",
  "legal.agreement": "הסכם שימוש",
  "legal.privacy": "מדיניות פרטיות",
  "legal.contact": "צור קשר",
  "legal.supportEmail": "support@velto.co.il",
  "legal.lastUpdated": "עדכון אחרון",
  "legal.acceptPrefix": "קראתי ואני מסכים/ה ל",
  "legal.acceptAnd": "ול",
  "legal.acceptRequired": "יש לאשר את התקנון ומדיניות הפרטיות כדי להירשם.",
  "footer.rights": "כל הזכויות שמורות",
  "footer.tagline": "שטחי פרסום חוץ בישראל, על מפה אחת",
  "nav.explore": "מפה",
  "nav.brief": "התאמת שטחים",
  "nav.dashboard": "אזור אישי",
  "nav.admin": "ניהול",
  "nav.login": "כניסה",
  "nav.register": "הרשמה",
  "nav.forgotPassword": "שכחתי סיסמה",
  "nav.logout": "יציאה",
  "nav.listYourSpace": "בעלי שטחים — פרסמו אצלנו",
  "nav.notifications": "התראות",
  "nav.skipToContent": "דילוג לתוכן הראשי",

  "common.loading": "טוען…",
  "common.save": "שמירה",
  "common.cancel": "ביטול",
  "common.back": "חזרה",
  "common.next": "המשך",
  "common.submit": "שליחה",
  "common.edit": "עריכה",
  "common.delete": "מחיקה",
  "common.close": "סגירה",
  "common.notProvided": "לא צוין",
  "common.unknown": "לא ידוע",
  "common.required": "שדה חובה",
  "common.optional": "רשות",
  "common.from": "החל מ־",
  "common.to": "עד",
  "common.results": "תוצאות",
  "common.error": "אירעה שגיאה. נסו שוב.",
  // The period a rate is quoted per. These were hardcoded Hebrew inside five
  // components, which is the one thing this file exists to prevent.
  "common.perMonth": "חודש",
  "common.perWeek": "שבוע",
  "common.demoData": "נתוני הדגמה",
  "common.demoDataNote": "רשומה זו נוצרה לצורכי פיתוח והדגמה ואינה מלאי מסחרי מאומת.",

  "map.title": "מפת שטחי הפרסום",
  "map.searchPlaceholder": "חיפוש עיר, רחוב או שם שטח…",
  "map.filters": "מסננים",
  "map.clearFilters": "ניקוי מסננים",
  "map.showResults": "הצגת {count} תוצאות",
  "map.resultsCount": "{count} שטחי פרסום",
  "map.noResults": "לא נמצאו שטחי פרסום באזור זה.",
  "map.noResultsHint": "נסו להרחיב את אזור המפה או לאפס את המסננים.",
  "map.viewAllIsrael": "תצוגת כל הארץ",
  "map.backToBeerSheva": "חזרה לבאר שבע",
  "map.inventoryNote": "מוצגים רק שטחים שקיימים במאגר VELTO.",
  "map.list": "רשימה",
  "map.tilesUnavailable": "רקע המפה אינו נטען כרגע. הסימונים והחיפוש פעילים.",
  "map.activeFilters": "סינון פעיל",
  "map.removeFilter": "הסרת המסנן",
  // Zero results with a filter on is a different situation from zero results
  // on an empty search, and it deserves a different sentence and a different
  // button. The generic one told everybody to clear everything.
  "map.noMatchTitle": "אין שטח שעונה על כל התנאים",
  "map.noMatchHint": "אפשר להסיר תנאי אחד ולראות מה נפתח.",
  "map.relaxFilter": "הסרת {filter}",

  "filter.city": "עיר",
  "filter.allCities": "כל הערים",
  "filter.assetType": "סוג שטח",
  "filter.availability": "זמינות",
  "filter.dates": "תאריכי קמפיין",
  "filter.priceRange": "טווח מחירים (חודשי)",
  "filter.minPrice": "מינימום",
  "filter.maxPrice": "מקסימום",
  "filter.digitalOnly": "דיגיטלי בלבד",
  "filter.verifiedOnly": "מאומתים בלבד",

  "asset.verification": "אימות",
  "asset.availability": "זמינות",
  "asset.location": "מיקום",
  "asset.specs": "מפרט",
  "asset.commercial": "מסחרי",
  "asset.type": "סוג",
  "asset.dimensions": "מידות",
  "asset.orientation": "כיוון",
  "asset.sides": "מספר צדדים",
  "asset.illumination": "תאורה",
  "asset.digital": "דיגיטלי",
  "asset.static": "סטטי",
  "asset.permit": "רישוי",
  "asset.priceWeekly": "מחיר שבועי",
  "asset.priceMonthly": "מחיר חודשי",
  "asset.priceFrom": "החל מ־",
  "asset.priceNotPublished": "המחיר אינו מפורסם — ניתן לבקש הצעת מחיר",
  "asset.priceEstimateNote": "המחיר הוא הערכה בלבד ואינו מהווה הצעה מחייבת.",
  "asset.minimumBooking": "תקופת הזמנה מינימלית",
  "asset.days": "ימים",
  "asset.extras": "כלול במחיר",
  "asset.production": "הפקה",
  "asset.installation": "התקנה",
  "asset.removal": "פירוק",
  "asset.notIncluded": "לא כלול",
  "asset.owner": "בעל השטח",
  "booking.fromInquiry": "צפייה בפנייה שממנה נוצרה ההזמנה →",
  "booking.cancelConfirm": "לבטל את ההזמנה? הצד השני יקבל על כך התראה.",
  "booking.cancelConfirmAction": "כן, לבטל את ההזמנה",
  "admin.deactivateConfirm": "להשבית את המשתמש? כל ההתחברויות הפעילות שלו ינותקו מיד.",
  "inquiry.thread": "שיחה על הפנייה",
  "inquiry.openThread": "פתיחת השיחה",
  "inquiry.newMessage": "הודעה חדשה",
  "inquiry.messagePlaceholder": "זמינות, מחיר, תנאים או שאלת המשך",
  "inquiry.send": "שליחת הודעה",
  "inquiry.lastMessage": "ההודעה האחרונה",
  "inquiry.messages": "הודעות",
  "inquiry.closed": "הפנייה נסגרה ולא ניתן להוסיף לה הודעות.",
  "asset.delete": "מחיקת השטח",
  "asset.deleteConfirm": "השטח טיוטה ואיש לא פנה לגביו — למחוק לצמיתות?",
  "asset.takeDown": "הסרה מהמפה",
  "asset.takeDownConfirm": "השטח יורד מהמפה ויעבור לסטטוס לא פעיל. להמשיך?",
  "asset.takeDownConfirmEngaged":
    "לשטח יש פניות או הזמנות, ולכן הוא יושבת ולא יימחק — מחיקה הייתה מוחקת גם את היסטוריית ההזמנות של הצד השני. להמשיך?",
  "asset.availabilityPeriods": "חלונות זמינות שהוגדרו",
  "asset.noPeriods": "בעל השטח טרם הגדיר חלונות זמינות.",
  "asset.save": "שמירה לרשימה",
  "asset.unsave": "הסרה מהרשימה",
  "asset.saved": "נשמר",
  "asset.requestAvailability": "בדיקת זמינות ומחיר",
  "asset.requestShort": "בקשת זמינות",
  "asset.requestQuote": "בקשת הצעת מחיר",
  "asset.requestBooking": "בקשת הזמנה",
  "asset.noImages": "אין תמונה",
  "asset.noImagesLong": "בעל השטח טרם העלה תמונות.",
  "asset.backToMap": "חזרה למפה",

  "verify.PENDING": "ממתין לאימות",
  "verify.VERIFIED": "מאומת ע״י VELTO",
  "verify.REJECTED": "נדחה באימות",
  "verify.PENDING.help": "הפרטים דווחו ע״י בעל השטח וטרם אומתו.",
  "verify.VERIFIED.help": "פרטי השטח נבדקו ואומתו ע״י VELTO.",
  "verify.VERIFIED.when": "אומת ע״י VELTO בתאריך",
  "verify.REJECTED.help": "השטח נדחה ואינו מוצג לציבור.",

  "avail.AVAILABLE": "זמין",
  "avail.PARTIAL": "זמין חלקית",
  "avail.OCCUPIED": "תפוס",
  "avail.INACTIVE": "לא פעיל",
  "avail.PENDING_VERIFICATION": "ממתין לאימות",
  "avail.AVAILABLE.help": "פנוי בכל התאריכים שנבחרו.",
  "avail.PARTIAL.help": "חלק מהתאריכים שנבחרו פנויים.",
  "avail.OCCUPIED.help": "התאריכים שנבחרו תפוסים.",
  "avail.INACTIVE.help": "השטח אינו פעיל להזמנות.",
  "avail.PENDING_VERIFICATION.help": "השטח ממתין לאימות VELTO.",

  "type.BILLBOARD": "שלט חוצות",
  "type.DIGITAL_BILLBOARD": "שלט דיגיטלי",
  "type.WALL": "קיר",
  "type.TOTEM": "טוטם",
  "type.BUS_STOP": "תחנת אוטובוס",
  "type.STREET_FURNITURE": "ריהוט רחוב",
  "type.BANNER": "באנר",
  "type.OTHER": "אחר",

  "brief.title": "התאמת שטחים לקמפיין",
  "brief.lead":
    "תארו את הקמפיין ונחזיר רשימה מדורגת מתוך המלאי שקיים באמת במערכת, " +
    "עם הסבר למה כל שטח נבחר ומה חסר בו.",
  "brief.freeText": "תיאור הקמפיין",
  "brief.freeTextPlaceholder": "לדוגמה: קמפיין בבאר שבע בנובמבר, תקציב 30 אלף, ליד הקניון והאוניברסיטה",
  "brief.parsed": "מה הבנו מהתיאור",
  "brief.submit": "מצא לי שטחים",
  "brief.reset": "ניקוי",
  "brief.startDate": "מתאריך",
  "brief.endDate": "עד תאריך",
  "brief.cities": "ערים",
  "brief.budget": "תקציב לקמפיין",
  "brief.dates": "תאריכי הקמפיין",
  "brief.types": "סוגי שטחים",
  "brief.tags": "סביבת השטח",
  "brief.results": "שטחים מתאימים",
  "brief.resultsCount": "שטחים שנמצאו",
  "brief.empty": "לא נמצאו שטחים שעונים על הבריף. נסו להרחיב את התאריכים, התקציב או הערים.",
  "brief.noInventory":
    "אין עדיין מלאי פעיל במערכת, ולכן אין מה להתאים. ברגע שבעלי שטחים יפרסמו, הבריף יתחיל להחזיר תוצאות.",
  "brief.askFirst": "מלאו לפחות פרט אחד — עיר, תאריכים או תקציב — כדי שנוכל להתאים.",
  "brief.why": "למה הותאם",
  "brief.gaps": "מה לא ידוע",
  "brief.priceForWindow": "הערכה לתקופה שביקשתם",
  "brief.howItWorks": "איך הדירוג עובד",
  "brief.honesty":
    "הדירוג מחושב רק מנתונים שבעלי השטחים הזינו ומיומן ההזמנות בפועל. " +
    "VELTO לא מודדת חשיפה, תנועה או דמוגרפיה, ולכן לא תמצאו כאן מספרי צפיות — " +
    "מספר כזה היה המצאה.",
  "brief.aiOn": "התיאור החופשי מנותח באמצעות מודל שפה. המודל רק מתרגם מילים לסינון — התוצאות עצמן מגיעות מהמלאי.",
  "brief.aiOff": "התיאור החופשי מנותח לפי כללים במערכת.",

  "brief.reason.partial": "חלק מהתאריכים פנויים",
  "brief.reason.freesUp": "תפוס בתאריכים שביקשתם, אבל מתפנה",
  "brief.reason.city": "נמצא בעיר שביקשתם",
  "brief.reason.type": "מסוג השטח שביקשתם",
  "brief.reason.digital": "שטח דיגיטלי",
  "brief.reason.tags": "הסביבה תואמת למה שביקשתם",
  "brief.reason.withinBudget": "בתוך התקציב",
  "brief.reason.verified": "מאומת ע״י VELTO",

  "brief.gap.noPrice": "בעל השטח לא פרסם מחיר",
  "brief.gap.overBudget": "מעל התקציב שציינתם",
  "brief.gap.noTags": "בעל השטח לא ציין מה יש מסביב",
  "brief.gap.noImage": "אין תמונה",
  "brief.gap.noSize": "לא צוינו מידות",

  "expiring.title": "חוזים שמסתיימים",
  "expiring.ownerLead": "הזמנות מאושרות שמסתיימות בקרוב — הרגע לחדש או להציע את השטח מחדש.",
  "expiring.freeingTitle": "מתפנה בקרוב",
  "expiring.freeingLead": "שטחים שההזמנה עליהם מסתיימת בימים הקרובים ויחזרו להיות זמינים.",
  "expiring.endsOn": "מסתיים ב",
  "expiring.freesOn": "מתפנה ב",
  "expiring.daysLeft": "ימים לסיום",
  "expiring.none": "אין הזמנות שמסתיימות בתקופה הזו.",
  "expiring.window": "בתוך כמה ימים",

  "tag.CITY_CENTER": "מרכז העיר",
  "tag.MALL": "ליד קניון או מרכז מסחרי",
  "tag.HIGHWAY": "כביש מהיר",
  "tag.MAIN_ROAD": "עורק תנועה ראשי",
  "tag.INDUSTRIAL": "אזור תעשייה או תעסוקה",
  "tag.RESIDENTIAL": "שכונת מגורים",
  "tag.TRANSIT_HUB": "צומת תחבורה",
  "tag.EDUCATION": "ליד מוסד חינוך או אקדמיה",
  "tag.HOSPITAL": "ליד בית חולים או מרפאה",
  "tag.STADIUM": "ליד אצטדיון או היכל ספורט",
  "tag.BEACH": "חוף או טיילת",
  "tag.sectionTitle": "מה יש מסביב לשטח",
  "tag.ownerHelp":
    "סמנו רק מה שנכון בפועל. VELTO לא מודדת חשיפה ולא מספרת כמה אנשים עוברים — " +
    "הסימון הזה מוצג למפרסמים כהצהרה שלכם, ולא כנתון שנמדד.",
  "tag.declared": "לפי הצהרת בעל השטח — לא נמדד",
  "tag.none": "בעל השטח לא ציין מה יש מסביב",

  "illum.NONE": "ללא תאורה",
  "illum.FRONTLIT": "תאורה קדמית",
  "illum.BACKLIT": "תאורה אחורית",
  "illum.UNKNOWN": "לא ידוע",

  "permit.UNKNOWN": "לא ידוע",
  "permit.PERMITTED": "בעל רישוי",
  "permit.NOT_PERMITTED": "ללא רישוי",
  "permit.note": "VELTO אינה מאשרת חוקיות שילוט. הסטטוס מדווח ע״י בעל השטח.",

  "status.DRAFT": "טיוטה",
  "status.ACTIVE": "פעיל",
  "status.INACTIVE": "לא פעיל",

  "inquiry.PENDING": "ממתינה למענה",
  "inquiry.RESPONDED": "נענתה",
  "inquiry.CLOSED": "סגורה",
  "intent.AVAILABILITY": "בדיקת זמינות",
  "intent.QUOTE": "הצעת מחיר",
  "intent.BOOKING": "בקשת הזמנה",

  "booking.REQUESTED": "ממתינה לאישור",
  "booking.APPROVED": "מאושרת",
  "booking.REJECTED": "נדחתה",
  "booking.CANCELLED": "בוטלה",
  "booking.COMPLETED": "הושלמה",
  "booking.contactOwner": "ההזמנה אושרה — פרטי בעל השטח ליצירת קשר והמשך התיאום",

  "role.ADVERTISER": "מפרסם",
  "role.MEDIA_OWNER": "בעל שטח",
  "role.ADMIN": "מנהל",

  "auth.login": "כניסה לחשבון",
  "auth.register": "יצירת חשבון",
  "auth.email": "דוא״ל",
  "auth.password": "סיסמה",
  "auth.name": "שם מלא",
  "auth.phone": "טלפון",
  "auth.companyName": "שם החברה",
  "auth.businessId": "ח.פ. / עוסק מורשה",
  "auth.role": "סוג החשבון",
  "auth.roleAdvertiser": "מפרסם / משרד פרסום — מחפש שטחי פרסום",
  "auth.roleOwner": "בעל שטחים — מפרסם מלאי",
  "auth.noAccount": "אין לכם חשבון?",
  "auth.hasAccount": "כבר יש לכם חשבון?",
  "auth.invalidCredentials": "דוא״ל או סיסמה שגויים.",
  "auth.emailTaken": "כתובת הדוא״ל כבר רשומה במערכת.",
  "auth.tooManyAttempts": "יותר מדי ניסיונות כניסה. נסו שוב בעוד מספר דקות.",
  "auth.passwordRule": "לפחות 8 תווים.",
  "auth.loginRequired": "יש להתחבר כדי להמשיך.",
  "auth.resetTokenInvalid": "קישור האיפוס אינו תקין או שפג תוקפו. בקשו קישור חדש.",
  "auth.forgotPasswordTitle": "שכחתי סיסמה",
  "auth.forgotPasswordHint": "הזינו את כתובת הדוא״ל שלכם ונשלח קישור לאיפוס הסיסמה, אם החשבון קיים.",
  "auth.forgotPasswordSent": "אם הכתובת רשומה במערכת, נשלח אליה קישור לאיפוס הסיסמה.",
  "auth.sendResetLink": "שליחת קישור לאיפוס",
  "auth.resetPasswordTitle": "איפוס סיסמה",
  "auth.newPassword": "סיסמה חדשה",
  "auth.resetPasswordSubmit": "עדכון סיסמה",
  "auth.resetPasswordSuccess": "הסיסמה עודכנה. ניתן להתחבר עם הסיסמה החדשה.",
  "auth.backToLogin": "חזרה לכניסה",

  "dash.overview": "סקירה",
  "dash.myRequests": "הבקשות שלי",
  "dash.myBookings": "ההזמנות שלי",
  "dash.savedAssets": "שטחים שמורים",
  "dash.profile": "פרופיל",
  "dash.myAssets": "השטחים שלי",

  // Account: the three rights the privacy policy promises.
  "account.details": "פרטים אישיים",
  "account.detailsHint": "השם והטלפון שיוצגו לצד שני בפניות ובהזמנות.",
  "account.company": "פרטי החברה",
  "account.companyHint": "פרטי הקשר של החברה הם אלה שמוצגים לציבור בדף השטח — לא הפרטים האישיים שלכם.",
  "account.emailLocked": "שינוי כתובת הדוא״ל אינו זמין עדיין. לפנייה בנושא: support@velto.co.il",
  "account.password": "שינוי סיסמה",
  "account.passwordHint": "שינוי סיסמה מנתק את כל ההתחברויות האחרות שלכם.",
  "account.currentPassword": "הסיסמה הנוכחית",
  "account.newPassword": "סיסמה חדשה",
  "account.changePassword": "עדכון סיסמה",
  "account.export": "המידע שלי",
  "account.exportHint":
    "הורדת כל המידע השמור עליכם ב-VELTO כקובץ JSON — פרטי החשבון, החברה, הפניות, ההזמנות והשטחים.",
  "account.exportAction": "הורדת המידע שלי",
  "account.danger": "מחיקת החשבון",
  "account.dangerHint":
    "מחיקת החשבון היא פעולה בלתי הפיכה. פרטי הזיהוי שלכם יימחקו מכל מקום שבו הם שמורים, וההזמנות עצמן יישמרו ללא שם כרשומה מסחרית של הצד השני. לא תוכלו להתחבר שוב.",
  "account.confirmWord": "להמשך, הקלידו את המילה מחיקה",
  "account.deleteAction": "מחיקת החשבון לצמיתות",
  "account.deleted": "החשבון נמחק. פרטי הזיהוי שלכם הוסרו מהמערכת.",
  "dash.availability": "זמינות",
  "dash.requests": "בקשות",
  "dash.bookings": "הזמנות",
  "dash.activeRequests": "בקשות פעילות",
  "dash.pendingResponses": "ממתינות למענה",
  "dash.upcomingBookings": "הזמנות קרובות",
  "dash.activeAssets": "שטחים פעילים",
  "dash.pendingRequests": "בקשות שממתינות לכם",
  "dash.confirmedBookings": "הזמנות מאושרות",
  "dash.addAsset": "הוספת שטח פרסום",
  "dash.noRequests": "אין לכם עדיין בקשות.",
  "dash.noRequestsHint": "מצאו שטח במפה ושלחו בקשת זמינות — הבקשות יופיעו כאן.",
  "dash.noBookings": "אין הזמנות להצגה.",
  "dash.noSaved": "שמרו כאן שטחים מעניינים כדי להשוות ביניהם מאוחר יותר.",
  "dash.noAssets": "עדיין לא הוספתם שטחי פרסום.",
  "dash.noAssetsHint": "הוסיפו את השטח הראשון שלכם כדי לקבל פניות ממפרסמים.",
  /*
   * The two sides, in their own words.
   *
   * Until now a logged-in page said "Overview" to both a person selling
   * billboard space and a person buying it, and both landed on four identical
   * stat tiles. The landing page speaks to each audience separately and that
   * voice stopped at the login screen. These are the strings that carry it in.
   *
   * The owner reads operationally - what is waiting, what is unfinished. The
   * advertiser reads as a buyer - what came back, what is running. Neither
   * side is ever told a number the database cannot produce: no earnings, no
   * views, no "listings like yours".
   */
  "owner.homeTitle": "לוח הבקרה שלכם",
  "owner.homeLead": "מה מחכה לכם היום, ומה מצב המלאי.",
  "owner.tasksTitle": "מה מחכה לכם",
  "owner.inventoryTitle": "המלאי שלכם",
  "owner.firstStepsTitle": "שלושה צעדים לשטח הראשון",
  "owner.firstStepsLead":
    "שטח שמפרסם יכול לראות, לתמחר ולבדוק תאריכים — בלי להרים אליכם טלפון.",
  "owner.step1": "הוסיפו את השטח: מיקום, תמונה ומחיר.",
  "owner.step2": "הגדירו חלון זמינות — בלעדיו השטח מוצג כתפוס.",
  "owner.step3": "פרסמו. VELTO תאמת את השטח לפני שהוא מסומן כמאומת.",
  "owner.waitingTitle": "השטחים באוויר",
  "owner.waitingLead":
    "עדיין לא הגיעו פניות. כשמפרסם יפנה — זה יופיע כאן, ותקבלו התראה.",
  "owner.pipelineValue": "צפי מהזמנות שממתינות לאישורכם",
  "task.inquiries-to-answer": "פניות שממתינות למענה שלכם",
  "task.bookings-to-decide": "הזמנות שממתינות להחלטה",
  "task.listings-incomplete": "שטחים שחסר בהם מידע שקונה מחפש",
  "task.contracts-ending": "חוזים שמסתיימים בקרוב",

  "adv.homeTitle": "הקמפיינים שלכם",
  "adv.homeLead": "מה חזר אליכם, ומה רץ עכשיו.",
  "adv.tasksTitle": "מה מחכה לכם",
  "adv.campaignsTitle": "הפעילות שלכם",
  "adv.firstStepsTitle": "איך מוצאים שטח",
  "adv.firstStepsLead": "תארו קמפיין וקבלו רשימה מדורגת, או חפשו ישירות על המפה.",
  "adv.step1": "תארו את הקמפיין — עיר, תאריכים ותקציב.",
  "adv.step2": "השוו שטחים, ושמרו את מה שמעניין.",
  "adv.step3": "שלחו בקשת זמינות ישירות לבעל השטח.",
  "adv.waitingTitle": "שמרתם שטחים — לא שלחתם עדיין בקשה",
  "adv.waitingLead": "בקשת זמינות היא הדרך לדעת אם השטח פנוי בתאריכים שלכם, ובכמה.",
  "task.replies-to-read": "בעלי שטח שהשיבו לכם",
  "task.bookings-approved": "הזמנות שאושרו",
  "task.saved-freeing-soon": "שטחים ששמרתם ומתפנים בקרוב",

  "readiness.incomplete": "חסר מידע",
  "readiness.ready": "מוכן לפרסום",
  "readiness.strong": "מלא",
  "readiness.photo": "תמונה",
  "readiness.price": "מחיר",
  "readiness.availability": "חלון זמינות",
  "readiness.dimensions": "מידות",
  "readiness.description": "תיאור",
  "readiness.surroundings": "מה יש מסביב",
  "readiness.missingTitle": "מה קונה לא יכול לראות",

  "dash.respond": "מענה למפרסם",
  "dash.approve": "אישור",
  "dash.reject": "דחייה",
  "dash.cancel": "ביטול",
  "dash.responseSent": "המענה נשלח.",
  "dash.conflict": "לא ניתן לאשר: קיימת כבר הזמנה מאושרת בתאריכים חופפים.",

  "wizard.step": "שלב",
  "wizard.of": "מתוך",
  "wizard.basic": "פרטים בסיסיים",
  "wizard.location": "מיקום",
  "wizard.specs": "מפרט",
  "wizard.pricing": "תמחור",
  "wizard.availability": "זמינות",
  "wizard.images": "תמונות",
  "wizard.review": "סקירה ופרסום",
  "wizard.publish": "פרסום השטח",
  "wizard.saveDraft": "שמירה כטיוטה",
  "wizard.saveAndContinue": "שמירה והמשך",
  "wizard.draftSaved": "הטיוטה נשמרה.",
  "wizard.pickOnMap": "לחצו על המפה כדי לסמן את מיקום השטח.",
  "wizard.published": "השטח פורסם וממתין לאימות VELTO.",

  "request.title": "בקשת זמינות ומחיר",
  "request.campaignName": "שם הקמפיין",
  "request.dates": "תאריכי הקמפיין",
  "request.budget": "תקציב משוער",
  "request.message": "הודעה לבעל השטח",
  "request.contact": "פרטי קשר",
  "request.submitted": "הבקשה נשלחה לבעל השטח.",
  "request.submittedHint": "תוכלו לעקוב אחריה באזור האישי.",
  "request.intent": "סוג הפנייה",
  "request.minDaysError": "תקופת ההזמנה קצרה מהמינימום שהוגדר לשטח.",
  "request.pastDateError": "לא ניתן לבחור תאריך שכבר עבר.",
  "request.dateOrderError": "תאריך הסיום חייב להיות אחרי תאריך ההתחלה.",

  "admin.users": "משתמשים",
  "admin.assets": "שטחים",
  "admin.verify": "אימות",
  "admin.approveAsset": "אימות השטח",
  "admin.rejectAsset": "דחיית השטח",
  "admin.deactivate": "השבתה",
  "admin.activate": "הפעלה",
  "admin.reviewNote": "הערת בדיקה",
  "admin.platform": "פעילות בפלטפורמה",
  "admin.growth": "צמיחה",
  "admin.newUsers30": "משתמשים חדשים (30 יום)",
  "admin.newAssets30": "שטחים חדשים (30 יום)",
  "admin.verificationFunnel": "סטטוס אימות",
  "admin.companies": "חברות",
  "admin.advertiserCompanies": "חברות מפרסמים",
  "admin.ownerCompanies": "חברות בעלי שטחים",
  "admin.topCities": "ערים מובילות לפי מלאי פעיל",
  "admin.pipelineValue": "צפי מהזמנות פתוחות",
  "admin.backup": "גיבוי מסד הנתונים",
  "admin.backupDownload": "הורדת גיבוי",
  "admin.backupNote":
    "הקובץ מכיל את כל נתוני המשתמשים וגיבוב של סיסמאותיהם. שמרו אותו במקום מוגן, " +
    "ואל תשאירו אותו בתיקיית ההורדות.",

  "notif.empty": "אין התראות חדשות.",
  "notif.markRead": "סימון כנקרא",
};

/** English keys fall back to Hebrew until the English pass is done. */
const en: Dict = {
  "app.tagline": "Outdoor advertising space in Israel - search, compare, request",
  "common.notProvided": "Not provided",
  "common.unknown": "Unknown",
  "avail.AVAILABLE": "Available",
  "avail.PARTIAL": "Partially available",
  "avail.OCCUPIED": "Booked",
  "avail.INACTIVE": "Inactive",
  "avail.PENDING_VERIFICATION": "Pending verification",
  "verify.VERIFIED": "Verified by VELTO",
  "verify.PENDING": "Pending verification",
  "verify.REJECTED": "Rejected",
};

const DICTS: Record<Locale, Dict> = { he, en };

/** Translate. Unknown keys return the key itself so gaps are visible, not silent. */
export function t(key: string, vars?: Record<string, string | number>, locale: Locale = DEFAULT_LOCALE): string {
  const dict = DICTS[locale] ?? he;
  let out = dict[key] ?? he[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/** Non-colour glyph for each availability state (accessibility requirement). */
export const AVAILABILITY_GLYPH: Record<AvailabilityState, string> = {
  AVAILABLE: "●",
  PARTIAL: "◐",
  OCCUPIED: "✕",
  INACTIVE: "—",
  PENDING_VERIFICATION: "?",
};
