import { describe, expect, it } from "vitest";
import {
  advertiserStage,
  advertiserTasks,
  ownerStage,
  ownerTasks,
} from "@/lib/home-stage";

/**
 * The rule these encode: never render a metric that can only say zero. A new
 * owner used to land on four tiles reading 0, 0, 0, ₪0 - which is the product
 * telling them it has nothing for them, in the place where it should be making
 * its case.
 */

describe("which stage an owner is at", () => {
  it("is empty with no assets, whatever else is true", () => {
    expect(ownerStage({ assets: 0, inquiries: 0, bookings: 0 })).toBe("empty");
  });

  it("is waiting once there are assets but nobody has come yet", () => {
    // There is a real thing to show here - their inventory - but every
    // activity number would be zero, so the page leads with the listings.
    expect(ownerStage({ assets: 3, inquiries: 0, bookings: 0 })).toBe("waiting");
  });

  it("is active on the first inquiry, not the first booking", () => {
    // An inquiry is the first time a stranger showed up. Waiting for a booking
    // to call it activity would leave the page blank through the whole of the
    // conversation that matters most.
    expect(ownerStage({ assets: 1, inquiries: 1, bookings: 0 })).toBe("active");
  });

  it("is active on a booking even with no inquiry on record", () => {
    expect(ownerStage({ assets: 1, inquiries: 0, bookings: 1 })).toBe("active");
  });
});

describe("which stage an advertiser is at", () => {
  it("is empty with nothing sent and nothing saved", () => {
    expect(advertiserStage({ requests: 0, bookings: 0, saved: 0 })).toBe("empty");
  });

  it("treats saving as a bookmark, not as activity", () => {
    // Someone can save a dozen spaces and still be at the very beginning, so
    // saved alone must never unlock a metrics view that would read zero.
    expect(advertiserStage({ requests: 0, bookings: 0, saved: 12 })).toBe("waiting");
  });

  it("is active once a request has been sent", () => {
    expect(advertiserStage({ requests: 1, bookings: 0, saved: 0 })).toBe("active");
  });
});

describe("the work queue", () => {
  it("drops anything at zero, so an empty queue renders as no queue", () => {
    const tasks = ownerTasks({
      pendingInquiries: 0,
      requestedBookings: 0,
      incompleteListings: 0,
      contractsEndingSoon: 0,
    });
    expect(tasks).toEqual([]);
  });

  it("keeps only what is actually waiting, in the order it is listed", () => {
    const tasks = ownerTasks({
      pendingInquiries: 2,
      requestedBookings: 0,
      incompleteListings: 1,
      contractsEndingSoon: 3,
    });
    expect(tasks.map((task) => task.kind)).toEqual([
      "inquiries-to-answer",
      "listings-incomplete",
      "contracts-ending",
    ]);
    expect(tasks.every((task) => task.count > 0)).toBe(true);
  });

  it("points every task at a page that exists", () => {
    const all = [
      ...ownerTasks({
        pendingInquiries: 1,
        requestedBookings: 1,
        incompleteListings: 1,
        contractsEndingSoon: 1,
      }),
      ...advertiserTasks({ respondedInquiries: 1, approvedBookings: 1, savedFreeingSoon: 1 }),
    ];
    expect(all).toHaveLength(7);
    for (const task of all) {
      expect(task.href.startsWith("/owner/") || task.href.startsWith("/dashboard/")).toBe(true);
    }
  });

  it("keeps the two sides' tasks disjoint", () => {
    const owner = ownerTasks({
      pendingInquiries: 1,
      requestedBookings: 1,
      incompleteListings: 1,
      contractsEndingSoon: 1,
    }).map((task) => task.kind);
    const advertiser = advertiserTasks({
      respondedInquiries: 1,
      approvedBookings: 1,
      savedFreeingSoon: 1,
    }).map((task) => task.kind);
    expect(owner.filter((kind) => advertiser.includes(kind))).toEqual([]);
  });
});
