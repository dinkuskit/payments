/**
 * One Authorize.net checkout that was paid more than once (payments-authorize-net-paid-twice-044): the order was
 * made from the first transaction, and the owner refunds the others by hand. Payments never refunds on its own.
 */
export type PaidTwiceNotice = {
  /** The paid transactions, first one first: Payments counts that one as the checkout's payment. */
  transactionIds: string[];
  total: { currency: "USD"; minor: string };
  /** When Payments found the extra payment, in milliseconds. */
  at: number;
};

/** Asks /v1/status to add `paidTwice`. Older Workers ignore the header, and older plugins never send it. */
export const PAID_TWICE_HEADER = Object.freeze({ name: "X-Dinkus-Payments-Alerts", value: "paid-twice" });
