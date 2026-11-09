const { Stripe } = require("stripe");
const { STRIPE, FRONTEND_URL } = require("../../../../config");
const { BadRequestError } = require("../../common/exceptions");

class StripeService {
  static instance;
  stripe;

  constructor() {
    if (StripeService.instance) return StripeService.instance;

    this.stripe = new Stripe(STRIPE.STRIPE_SECRET_KEY, {
      timeout: STRIPE.REQUEST_TIMEOUT_MS,
      maxNetworkRetries: STRIPE.MAX_NETWORK_RETRIES,
    });

    StripeService.instance = this;
  }

  // ================= PLATFORM ================
  async getPlatformBalance() {
    const balance = await this.stripe.balance.retrieve();

    return {
      available: balance.available,
      pending: balance.pending,
    };
  }

  // ================= CUSTOMER =================

  async createCustomer({ email, name, metadata = {} }) {
    return this.stripe.customers.create({
      email,
      name,
      metadata,
    });
  }

  async getCustomer(customerId) {
    return this.stripe.customers.retrieve(customerId);
  }

  // ================= PAYMENT INTENT =================

  async createPaymentIntent({
    amount,
    currency = "usd",
    customerId,
    paymentMethodId,
    metadata = {},
    idempotencyKey,
  }) {
    const params = {
      amount,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      metadata,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    };

    return this.stripe.paymentIntents.create(
      params,
      idempotencyKey ? { idempotencyKey } : undefined,
    );
  }

  // ================= CARD (PAYMENT METHOD) =================

  async attachCard({ customerId, paymentMethodId }) {
    return this.stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });
  }

  async detachCard(paymentMethodId) {
    return this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async listCards(customerId) {
    return this.stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });
  }

  // ================= BANK ACCOUNT =================

  async addBankAccount({ accountId, token }) {
    return this.stripe.accounts.createExternalAccount(accountId, {
      external_account: token,
    });
  }

  async removeBankAccount(accountId, bankAccountId) {
    return this.stripe.accounts.deleteExternalAccount(accountId, bankAccountId);
  }

  async setDefaultBankAccount(accountId, bankAccountId) {
    const bankAccount = await this.stripe.accounts.updateExternalAccount(
      accountId,
      bankAccountId,
      { default_for_currency: true },
    );

    return bankAccount;
  }

  // ================= PAYOUT / ROUTING (Connected Accounts) =================

  async createConnectedAccount({ email, country = "US" }) {
    const account = await this.stripe.accounts.create({
      type: "custom",
      country,
      email,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
      settings: {
        payouts: { schedule: { interval: "manual" } },
      },
      ...(country == "PK" && {
        tos_acceptance: {
          service_agreement: "recipient",
        },
      }),
    });

    return account.id;
  }

  async createAccountLink(accountId, type, refreshUrl, returnUrl) {
    return await this.stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type,
      collection_options: {
        future_requirements: "include",
        fields: "eventually_due",
      },
    });
  }

  // ================= TRANSFER / ROUTING MONEY =================

  async transferToAccount({
    amount,
    currency = "usd",
    destinationAccountId,
    metadata = {},
  }) {
    const balance = (await this.getPlatformBalance()).available[0];

    if (balance.account < amount) {
      throw new BadRequestError("Insufficient funds in escrow account");
    }

    return this.stripe.transfers.create({
      amount,
      currency,
      destination: destinationAccountId,
      metadata,
    });
  }

  async createPayout(
    amount,
    currency = "usd",
    accountId,
    bankId,
    metadata = {},
  ) {
    const payout = await this.stripe.payouts.create(
      {
        amount,
        currency,
        metadata,
        destination: bankId,
      },
      {
        stripeAccount: accountId,
      },
    );

    return payout;
  }

  // ================= REFUND =================

  async refundPayment(
    paymentIntentId,
    amount,
    { idempotencyKey, metadata } = {},
  ) {
    return this.stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount,
        ...(metadata ? { metadata } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    );
  }

  // ================= SUBSCRIPTIONS =================
  async getPlans() {
    const products = await this.stripe.products.list({
      active: true,
    });

    const plans = await this.stripe.prices.list({
      active: true,
      type: "recurring",
    });

    const plansWithProductDetails = plans.data.map((plan) => {
      const product = products.data.find((p) => p.id === plan.product);
      return {
        id: plan.id,
        nickname: plan.nickname,
        amount: plan.unit_amount,
        currency: plan.currency,
        interval: plan.recurring.interval,
        product: {
          id: product.id,
          name: product.name,
          description: product.description,
        },
      };
    });

    return plansWithProductDetails;
  }

  async purchaseSubscription(priceId, metadata = {}) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId, // must be a recurring price
          quantity: 1,
        },
      ],
      metadata: {
        driverId: metadata.driverId,
      },
      subscription_data: {
        metadata: {
          driverId: metadata.driverId,
        },
      },
      success_url: `${FRONTEND_URL}/subscription`,
      cancel_url: `${FRONTEND_URL}/subscription`,
    });

    return session.url;
  }

  async cancelSubscription(stripeSubscriptionId, cancelImmediate = false) {
    if (cancelImmediate) {
      return await this.stripe.subscriptions.cancel(stripeSubscriptionId);
    }

    return await this.stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
  }

  // ================= INVOICES =================
  async voidInvoice(invoiceId) {
    return this.stripe.invoices.voidInvoice(invoiceId);
  }

  finalizeInvoice(invoiceId) {
    return this.stripe.invoices.finalizeInvoice(invoiceId);
  }
}

module.exports = new StripeService();
