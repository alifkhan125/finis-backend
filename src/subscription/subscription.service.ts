import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  VerifyCheckoutDto,
  MobileSubscribeDto,
  MobileConfirmDto,
} from './subscription.dto';
import * as bcrypt from 'bcryptjs';
import Stripe from 'stripe';

@Injectable()
export class SubscriptionService {
  private readonly stripe: InstanceType<typeof Stripe>;

  constructor(private readonly prisma: PrismaService) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
      apiVersion: '2026-04-22.dahlia' as any,
    });
  }

  private get frontendUrl() {
    return process.env.FRONTEND_URL || 'http://localhost:5173';
  }

  // ─── Stripe Helpers ─────────────────────────────────────────────────────────

  /**
   * Stripe Basil API (2025+): current_period_start/end moved from Subscription
   * root to each subscription item. We check item first, fallback to root.
   */
  private getSubscriptionPeriod(subscription: any): {
    start: number | null;
    end: number | null;
  } {
    const item = subscription?.items?.data?.[0];
    const start =
      item?.current_period_start ??
      subscription?.current_period_start ??
      subscription?.latest_invoice?.lines?.data?.[0]?.period?.start ??
      subscription?.start_date ??
      null;
    const end =
      item?.current_period_end ??
      subscription?.current_period_end ??
      subscription?.latest_invoice?.lines?.data?.[0]?.period?.end ??
      null;
    return { start, end };
  }

  /**
   * Stripe Basil API: invoice.subscription moved to
   * invoice.parent.subscription_details.subscription
   */
  private getSubscriptionIdFromInvoice(invoice: any): string | null {
    const fromParent =
      invoice?.parent?.type === 'subscription_details'
        ? invoice?.parent?.subscription_details?.subscription
        : null;
    const value = fromParent ?? invoice?.subscription ?? null;
    if (!value) return null;
    return typeof value === 'string' ? value : (value?.id ?? null);
  }

  /**
   * Ensure the plan has Stripe product + price IDs. Creates them if missing.
   */
  private async ensurePlanStripePrices(plan: any) {
    const product = plan.stripeProductId
      ? await this.stripe.products.retrieve(plan.stripeProductId)
      : await this.stripe.products.create({
          name: plan.name,
          metadata: { planId: plan.id },
        });

    const resolvePrice = async (
      priceId: string | null | undefined,
      interval: 'month' | 'year',
      amount: number,
    ) => {
      if (priceId) {
        try {
          const existing = await this.stripe.prices.retrieve(priceId);
          if (
            existing?.recurring?.interval === interval &&
            existing?.active !== false
          ) {
            return existing.id;
          }
        } catch {
          // fall through to recreate
        }
      }
      const created = await this.stripe.prices.create({
        product: product.id,
        currency: 'usd',
        unit_amount: Math.round(Number(amount) * 100),
        recurring: { interval },
        metadata: { planId: plan.id },
      });
      return created.id;
    };

    const monthlyPriceId = await resolvePrice(
      plan.stripePriceMonthlyId,
      'month',
      plan.priceMonthly,
    );

    let yearlyPriceId: string | null = plan.stripePriceYearlyId ?? null;
    if (plan.priceYearly != null && !yearlyPriceId) {
      yearlyPriceId = await resolvePrice(null, 'year', plan.priceYearly);
    }

    return this.prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: {
        stripeProductId: product.id,
        stripePriceMonthlyId: monthlyPriceId,
        stripePriceYearlyId: yearlyPriceId,
      },
    });
  }

  // ─── Plan / Tenant Helpers ───────────────────────────────────────────────────

  private resolvePlanAmount(plan: any, interval: string): number {
    if (interval === 'yearly')
      return plan?.priceYearly ?? plan?.priceMonthly ?? 0;
    return plan?.priceMonthly ?? 0;
  }

  private async resolvePlanFromStripePrice(stripePriceId: string | null) {
    if (!stripePriceId) return null;
    return this.prisma.subscriptionPlan.findFirst({
      where: {
        OR: [
          { stripePriceMonthlyId: stripePriceId },
          { stripePriceYearlyId: stripePriceId },
        ],
      },
    });
  }

  private resolvePlanIntervalFromStripePrice(
    plan: {
      stripePriceMonthlyId: string | null;
      stripePriceYearlyId: string | null;
    } | null,
    stripePriceId: string | null,
  ): 'monthly' | 'yearly' | null {
    if (!plan || !stripePriceId) return null;
    if (plan.stripePriceYearlyId === stripePriceId) return 'yearly';
    if (plan.stripePriceMonthlyId === stripePriceId) return 'monthly';
    return null;
  }

  private async findTenantBySubscriptionId(subscriptionId: string) {
    return this.prisma.tenant.findFirst({
      where: { stripeSubscriptionId: subscriptionId },
      include: {
        plan: true,
        users: { where: { role: 'admin' }, select: { id: true }, take: 1 },
      },
    });
  }

  private async findTenantByCustomerId(customerId: string) {
    return this.prisma.tenant.findFirst({
      where: { stripeCustomerId: customerId },
      include: {
        plan: true,
        users: { where: { role: 'admin' }, select: { id: true }, take: 1 },
      },
    });
  }

  // ─── SubscriptionPurchase ────────────────────────────────────────────────────

  /**
   * Upsert করে tenantId + stripeSubscriptionId দিয়ে।
   * stripeSubscriptionId null হলে tenantId + planId + interval দিয়ে match করে।
   */
  private async upsertSubscriptionPurchase(params: {
    tenantId: string;
    userId: string;
    planId: string;
    planName: string;
    stripeSubscriptionId: string | null;
    stripePriceId: string | null;
    interval: string;
    amount: number;
    status: 'active' | 'canceled' | 'expired' | 'switched';
    startedAt?: Date;
    endedAt?: Date | null;
    canceledAt?: Date | null;
  }) {
    const where = params.stripeSubscriptionId
      ? {
          tenantId: params.tenantId,
          stripeSubscriptionId: params.stripeSubscriptionId,
        }
      : {
          tenantId: params.tenantId,
          planId: params.planId,
          interval: params.interval,
        };

    const existing = await this.prisma.subscriptionPurchase.findFirst({
      where,
      select: { id: true },
    });

    const data = {
      planId: params.planId,
      planName: params.planName,
      stripePriceId: params.stripePriceId,
      interval: params.interval,
      amount: params.amount,
      status: params.status,
      startedAt: params.startedAt ?? new Date(),
      endedAt: params.endedAt ?? null,
      canceledAt: params.canceledAt ?? null,
    };

    if (existing) {
      return this.prisma.subscriptionPurchase.update({
        where: { id: existing.id },
        data,
      });
    }

    return this.prisma.subscriptionPurchase.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        stripeSubscriptionId: params.stripeSubscriptionId,
        ...data,
      },
    });
  }

  // ─── Sync from Stripe ────────────────────────────────────────────────────────

  /**
   * Stripe থেকে latest subscription data pull করে DB sync করে।
   */
  private async syncTenantFromStripeSubscription(
    subscriptionId: string,
    knownTenantId?: string,
  ) {
    const subscription = await this.stripe.subscriptions.retrieve(
      subscriptionId,
      {
        expand: ['latest_invoice.lines'],
      },
    );
    const stripeStatus = subscription.status;
    const isActive = stripeStatus === 'active' || stripeStatus === 'trialing';

    const stripePriceId =
      typeof subscription.items?.data?.[0]?.price?.id === 'string'
        ? subscription.items.data[0].price.id
        : null;

    let tenant = knownTenantId
      ? await this.prisma.tenant.findUnique({
          where: { id: knownTenantId },
          include: {
            plan: true,
            users: { where: { role: 'admin' }, select: { id: true }, take: 1 },
          },
        })
      : null;

    if (!tenant) {
      tenant = await this.findTenantBySubscriptionId(subscriptionId);
    }
    if (!tenant && subscription.customer) {
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : (subscription.customer as any).id;
      tenant = await this.findTenantByCustomerId(customerId);
    }
    if (!tenant) return null;

    const period = this.getSubscriptionPeriod(subscription);
    const matchedPlan = await this.resolvePlanFromStripePrice(stripePriceId);
    const matchedInterval = this.resolvePlanIntervalFromStripePrice(
      matchedPlan,
      stripePriceId,
    );

    const startDate = period.start ? new Date(period.start * 1000) : new Date();
    const endDate = period.end
      ? new Date(period.end * 1000)
      : new Date(
          Date.now() +
            (matchedInterval === 'yearly' ? 365 : 30) * 24 * 60 * 60 * 1000,
        );

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: isActive ? 'active' : 'suspended',
        subscriptionStatus: stripeStatus as any,
        stripeSubscriptionId: subscription.id,
        stripePriceId: stripePriceId ?? undefined,
        planId: matchedPlan?.id ?? undefined,
        planInterval: matchedInterval ?? undefined,
        currentPeriodStart: startDate,
        currentPeriodEnd: endDate,
      },
    });

    const effectivePlan = matchedPlan ?? tenant.plan;
    const effectiveInterval =
      matchedInterval ?? tenant.planInterval ?? 'monthly';
    const amount = this.resolvePlanAmount(effectivePlan, effectiveInterval);

    const adminUser =
      tenant.users?.[0] ??
      (await this.prisma.user.findFirst({
        where: { tenantId: tenant.id, role: 'admin' },
        select: { id: true },
      }));

    if (effectivePlan && adminUser) {
      await this.upsertSubscriptionPurchase({
        tenantId: tenant.id,
        userId: adminUser.id,
        planId: effectivePlan.id,
        planName: effectivePlan.name,
        stripeSubscriptionId: subscription.id,
        stripePriceId,
        interval: effectiveInterval,
        amount,
        status:
          stripeStatus === 'canceled'
            ? 'canceled'
            : isActive
              ? 'active'
              : 'expired',
        startedAt: startDate,
        endedAt: endDate,
      });
    }

    return subscription;
  }

  // ─── Plan Switch (no payment) ────────────────────────────────────────────────

  /**
   * Admin আগের কেনা plan-এ ফিরতে চায়, যার duration এখনো বাকি।
   * কোনো payment নেই — শুধু tenant pointer change + current plan cancel_at_period_end।
   */
  private async switchToExistingSubscription(params: {
    tenant: any;
    plan: any;
    interval: string;
    targetSubscriptionId: string;
  }) {
    const { tenant, plan, interval, targetSubscriptionId } = params;

    // Verify target subscription is still valid
    let targetSub: any;
    try {
      targetSub =
        await this.stripe.subscriptions.retrieve(targetSubscriptionId);
    } catch {
      throw new BadRequestException(
        'Previous subscription could not be verified with Stripe',
      );
    }

    if (targetSub.status !== 'active' && targetSub.status !== 'trialing') {
      throw new BadRequestException(
        'That plan is no longer active. Please purchase it again.',
      );
    }

    const period = this.getSubscriptionPeriod(targetSub);
    if (period.end && period.end * 1000 < Date.now()) {
      throw new BadRequestException(
        'That plan has already expired. Please purchase it again.',
      );
    }

    // resume করো যদি cancel_at_period_end ছিল
    if (targetSub.cancel_at_period_end) {
      await this.stripe.subscriptions.update(targetSubscriptionId, {
        cancel_at_period_end: false,
      });
    }

    // current active subscription টা period end-এ cancel করো
    if (
      tenant.stripeSubscriptionId &&
      tenant.stripeSubscriptionId !== targetSubscriptionId
    ) {
      await this.stripe.subscriptions.update(tenant.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });

      // current purchase কে "switched" mark করো
      const currentPurchase = await this.prisma.subscriptionPurchase.findFirst({
        where: {
          tenantId: tenant.id,
          stripeSubscriptionId: tenant.stripeSubscriptionId,
        },
      });
      if (currentPurchase) {
        await this.prisma.subscriptionPurchase.update({
          where: { id: currentPurchase.id },
          data: { status: 'switched', canceledAt: new Date() },
        });
      }
    }

    const stripePriceId =
      typeof targetSub.items?.data?.[0]?.price?.id === 'string'
        ? targetSub.items.data[0].price.id
        : null;

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        planId: plan.id,
        planInterval: interval,
        stripeSubscriptionId: targetSubscriptionId,
        stripePriceId: stripePriceId ?? undefined,
        subscriptionStatus: 'active',
        status: 'active',
        currentPeriodStart: period.start
          ? new Date(period.start * 1000)
          : undefined,
        currentPeriodEnd: period.end ? new Date(period.end * 1000) : undefined,
      },
    });

    const adminUser = await this.prisma.user.findFirst({
      where: { tenantId: tenant.id, role: 'admin' },
      select: { id: true },
    });

    if (adminUser) {
      await this.upsertSubscriptionPurchase({
        tenantId: tenant.id,
        userId: adminUser.id,
        planId: plan.id,
        planName: plan.name,
        stripeSubscriptionId: targetSubscriptionId,
        stripePriceId,
        interval,
        amount: this.resolvePlanAmount(plan, interval),
        status: 'active',
        startedAt: period.start ? new Date(period.start * 1000) : new Date(),
        endedAt: period.end ? new Date(period.end * 1000) : null,
      });
    }

    return {
      switched: true,
      checkoutUrl: null,
      message:
        'Switched back to previously paid plan. No new payment required.',
      tenantId: tenant.id,
      planId: plan.id,
    };
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  async verifyAndCheckout(dto: VerifyCheckoutDto) {
    // 1. Admin verify
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, role: 'admin', status: 'active' },
    });
    if (!user) throw new NotFoundException('Admin user not found');

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!isPasswordValid) throw new ForbiddenException('Invalid credentials');

    // 2. Plan verify
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: dto.planId },
    });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    if (!plan.isActive)
      throw new BadRequestException('This plan is not currently available');
    if (plan.visibility !== 'public')
      throw new BadRequestException('This plan is private and must be assigned by an admin');

    // 3. Tenant
    const tenant = user.tenantId
      ? await this.prisma.tenant.findUnique({
          where: { id: user.tenantId },
          include: { plan: true },
        })
      : null;

    // 4. Same plan + same interval + still active → block duplicate
    if (tenant) {
      const isSamePlanActive =
        tenant.subscriptionStatus === 'active' &&
        tenant.planId === plan.id &&
        tenant.planInterval === dto.interval &&
        tenant.currentPeriodEnd != null &&
        new Date(tenant.currentPeriodEnd).getTime() > Date.now();

      if (isSamePlanActive) {
        throw new BadRequestException(
          'You already have an active subscription for this plan and billing cycle.',
        );
      }

      // 5. Check করো আগের কেনা subscription আছে কিনা যেটার duration এখনো বাকি
      //    (different plan বা interval হতে পারে — ager ta te back jaowa)
      const previousPurchase = await this.prisma.subscriptionPurchase.findFirst(
        {
          where: {
            tenantId: tenant.id,
            planId: plan.id,
            interval: dto.interval,
            status: 'active',
            stripeSubscriptionId: { not: null },
            endedAt: { gt: new Date() },
          },
        },
      );

      if (previousPurchase?.stripeSubscriptionId) {
        // আগের plan-এ ফেরত — কোনো payment নেই
        return this.switchToExistingSubscription({
          tenant,
          plan,
          interval: dto.interval,
          targetSubscriptionId: previousPurchase.stripeSubscriptionId,
        });
      }
    }

    // 6. Create tenant if not exists
    const activeTenant =
      tenant ??
      (await this.prisma.tenant.create({
        data: {
          name: user.fullName || user.email.split('@')[0] || 'New Tenant',
          billingEmail: user.email,
          planId: plan.id,
          status: 'trial',
          subscriptionStatus: 'pending',
          planInterval: dto.interval,
        },
      }));

    // 7. Stripe customer
    const customer = activeTenant.stripeCustomerId
      ? await this.stripe.customers.retrieve(activeTenant.stripeCustomerId)
      : await this.stripe.customers.create({
          email: activeTenant.billingEmail || user.email,
          name: activeTenant.name,
          metadata: { tenantId: activeTenant.id },
        });

    // 8. Ensure Stripe prices exist
    const syncedPlan = await this.ensurePlanStripePrices(plan);
    const priceId =
      dto.interval === 'yearly'
        ? (syncedPlan.stripePriceYearlyId ?? syncedPlan.stripePriceMonthlyId)
        : syncedPlan.stripePriceMonthlyId;

    if (!priceId) {
      throw new BadRequestException(
        'Stripe price not configured for this plan',
      );
    }

    // 9. Stripe Checkout session
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${this.frontendUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.frontendUrl}/subscription/cancel`,
      metadata: {
        tenantId: activeTenant.id,
        planId: plan.id,
        adminUserId: user.id,
        interval: dto.interval,
        priceId,
      },
    });

    // 10. Save customer + price info immediately (webhook আসার আগে জানার জন্য)
    await this.prisma.tenant.update({
      where: { id: activeTenant.id },
      data: {
        stripeCustomerId: customer.id,
        stripePriceId: priceId,
        planInterval: dto.interval,
        ...(user.tenantId == null
          ? { users: { connect: { id: user.id } } }
          : {}),
      },
    });

    if (user.tenantId == null) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { tenantId: activeTenant.id },
      });
    }

    return { checkoutUrl: session.url };
  }

  async createInAppSubscription(dto: VerifyCheckoutDto) {
    // 1. Admin verify
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, role: 'admin', status: 'active' },
    });
    if (!user) throw new NotFoundException('Admin user not found');

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!isPasswordValid) throw new ForbiddenException('Invalid credentials');

    // 2. Plan verify
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: dto.planId },
    });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    if (!plan.isActive)
      throw new BadRequestException('This plan is not currently available');
    if (plan.visibility !== 'public')
      throw new BadRequestException('This plan is private and must be assigned by an admin');

    // 3. Tenant check
    const tenant = user.tenantId
      ? await this.prisma.tenant.findUnique({
          where: { id: user.tenantId },
          include: { plan: true },
        })
      : null;

    if (tenant) {
      const isSamePlanActive =
        tenant.subscriptionStatus === 'active' &&
        tenant.planId === plan.id &&
        tenant.planInterval === dto.interval &&
        tenant.currentPeriodEnd != null &&
        new Date(tenant.currentPeriodEnd).getTime() > Date.now();

      if (isSamePlanActive) {
        throw new BadRequestException(
          'You already have an active subscription for this plan and billing cycle.',
        );
      }
    }

    // 4. Create tenant if not exists
    const activeTenant =
      tenant ??
      (await this.prisma.tenant.create({
        data: {
          name: user.fullName || user.email.split('@')[0] || 'New Tenant',
          billingEmail: user.email,
          planId: plan.id,
          status: 'trial',
          subscriptionStatus: 'pending',
          planInterval: dto.interval,
        },
      }));

    // 5. Stripe customer
    const customer = activeTenant.stripeCustomerId
      ? await this.stripe.customers.retrieve(activeTenant.stripeCustomerId)
      : await this.stripe.customers.create({
          email: activeTenant.billingEmail || user.email,
          name: activeTenant.name,
          metadata: { tenantId: activeTenant.id },
        });

    // 6. Ensure Stripe prices exist
    const syncedPlan = await this.ensurePlanStripePrices(plan);
    const priceId =
      dto.interval === 'yearly'
        ? (syncedPlan.stripePriceYearlyId ?? syncedPlan.stripePriceMonthlyId)
        : syncedPlan.stripePriceMonthlyId;

    if (!priceId) {
      throw new BadRequestException(
        'Stripe price not configured for this plan',
      );
    }

    // 7. Create Stripe subscription with default_incomplete
    const subscription = await this.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        tenantId: activeTenant.id,
        planId: plan.id,
        adminUserId: user.id,
        interval: dto.interval,
        priceId,
      },
    });

    let clientSecret: string | undefined;

    // 1. Try from expanded invoice
    const invoice = subscription.latest_invoice as any;
    if (invoice && typeof invoice === 'object') {
      if (typeof invoice.payment_intent === 'string') {
        try {
          const pi = await this.stripe.paymentIntents.retrieve(
            invoice.payment_intent,
          );
          clientSecret = pi.client_secret ?? undefined;
        } catch {
          // ignore
        }
      } else if (invoice.payment_intent?.client_secret) {
        clientSecret = invoice.payment_intent.client_secret;
      }
    }

    // 2. Try looking up the customer's recent PaymentIntents
    if (!clientSecret && customer.id) {
      try {
        const paymentIntents = await this.stripe.paymentIntents.list({
          customer: customer.id,
          limit: 5,
        });
        const matchedPi = paymentIntents.data.find(
          (pi: any) =>
            pi.status === 'requires_payment_method' ||
            pi.status === 'requires_action' ||
            pi.status === 'requires_confirmation',
        );
        if (matchedPi?.client_secret) {
          clientSecret = matchedPi.client_secret;
        }
      } catch (err) {
        console.warn('Failed to list payment intents for customer:', err);
      }
    }

    // 3. Try setup intent if applicable
    if (!clientSecret && subscription.pending_setup_intent) {
      try {
        const setupIntent =
          typeof subscription.pending_setup_intent === 'string'
            ? await this.stripe.setupIntents.retrieve(
                subscription.pending_setup_intent,
              )
            : subscription.pending_setup_intent;
        clientSecret = setupIntent?.client_secret ?? undefined;
      } catch (err) {
        console.warn('Failed to retrieve setup intent for customer:', err);
      }
    }

    if (!clientSecret) {
      throw new BadRequestException(
        'Could not create payment intent for subscription',
      );
    }

    // Save customer + subscription reference on tenant
    await this.prisma.tenant.update({
      where: { id: activeTenant.id },
      data: {
        stripeCustomerId: customer.id,
        stripePriceId: priceId,
        planInterval: dto.interval,
        stripeSubscriptionId: subscription.id,
        ...(user.tenantId == null
          ? { users: { connect: { id: user.id } } }
          : {}),
      },
    });

    if (user.tenantId == null) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { tenantId: activeTenant.id },
      });
    }

    return {
      clientSecret,
      subscriptionId: subscription.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    };
  }

  async confirmInAppSubscription(subscriptionId: string) {
    const updatedTenant =
      await this.syncTenantFromStripeSubscription(subscriptionId);
    return {
      success: true,
      tenant: updatedTenant,
    };
  }

  async handleWebhook(rawBody: Buffer | undefined, signature?: string) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret)
      throw new BadRequestException('Stripe webhook secret is missing');
    if (!signature) throw new BadRequestException('Missing Stripe signature');
    if (!rawBody) throw new BadRequestException('Missing raw request body');

    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      secret,
    );
    console.log('[Webhook]', event.type);

    switch (event.type) {
      case 'checkout.session.completed': {
        await this.handleCheckoutCompleted(event.data.object as any);
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        await this.handleInvoicePaid(event.data.object as any);
        break;
      }

      case 'invoice_payment.paid': {
        const invoicePayment = event.data.object as any;
        if (invoicePayment?.invoice) {
          const invoice = await this.stripe.invoices.retrieve(
            invoicePayment.invoice,
          );
          await this.handleInvoicePaid(invoice);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        const subscriptionId = this.getSubscriptionIdFromInvoice(invoice);
        if (subscriptionId) {
          await this.prisma.tenant.updateMany({
            where: { stripeSubscriptionId: subscriptionId },
            data: { status: 'suspended', subscriptionStatus: 'past_due' },
          });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as any;
        if (sub?.id) await this.syncTenantFromStripeSubscription(sub.id);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as any;
        if (!sub?.id) break;
        await this.prisma.tenant.updateMany({
          where: { stripeSubscriptionId: sub.id },
          data: { status: 'cancelled', subscriptionStatus: 'cancelled' },
        });
        await this.prisma.subscriptionPurchase.updateMany({
          where: { stripeSubscriptionId: sub.id, status: 'active' },
          data: { status: 'canceled', canceledAt: new Date() },
        });
        break;
      }

      default:
        break;
    }

    return { received: true };
  }

  private async handleCheckoutCompleted(session: any) {
    const {
      tenantId,
      planId,
      adminUserId,
      interval = 'monthly',
      priceId,
    } = session.metadata ?? {};
    if (!planId || !adminUserId) return;

    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription?.id ?? null);

    const customerId =
      typeof session.customer === 'string'
        ? session.customer
        : (session.customer?.id ?? null);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        plan: true,
        users: { where: { role: 'admin' }, select: { id: true }, take: 1 },
      },
    });

    if (!tenant) {
      console.warn('[Webhook] checkout.session.completed — tenant not found', {
        tenantId,
      });
      return;
    }

    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });
    const user = await this.prisma.user.findUnique({
      where: { id: adminUserId },
      select: { id: true },
    });

    const subscription = subscriptionId
      ? await this.stripe.subscriptions.retrieve(subscriptionId)
      : null;
    const period = this.getSubscriptionPeriod(subscription);

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: 'active',
        planId,
        planInterval: interval,
        stripeCustomerId: customerId ?? undefined,
        stripeSubscriptionId: subscriptionId ?? undefined,
        stripePriceId: priceId ?? undefined,
        subscriptionStatus:
          session.payment_status === 'paid' ? 'active' : 'pending',
        currentPeriodStart: period.start
          ? new Date(period.start * 1000)
          : undefined,
        currentPeriodEnd: period.end ? new Date(period.end * 1000) : undefined,
      },
    });

    if (plan && user) {
      await this.upsertSubscriptionPurchase({
        tenantId: tenant.id,
        userId: user.id,
        planId: plan.id,
        planName: plan.name,
        stripeSubscriptionId: subscriptionId ?? null,
        stripePriceId: priceId ?? null,
        interval,
        amount: this.resolvePlanAmount(plan, interval),
        status: 'active',
        startedAt: period.start ? new Date(period.start * 1000) : new Date(),
        endedAt: period.end ? new Date(period.end * 1000) : null,
      });
    }
  }

  private async handleInvoicePaid(invoice: any) {
    const subscriptionId = this.getSubscriptionIdFromInvoice(invoice);
    if (!subscriptionId) return;

    const subscription =
      await this.stripe.subscriptions.retrieve(subscriptionId);
    const period = this.getSubscriptionPeriod(subscription);
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : (subscription.customer?.id ?? null);

    const tenant =
      (await this.findTenantBySubscriptionId(subscriptionId)) ??
      (customerId ? await this.findTenantByCustomerId(customerId) : null);

    if (!tenant) {
      console.warn('[Webhook] invoice.paid — tenant not found', {
        subscriptionId,
        customerId,
      });
      return;
    }

    const stripePriceId =
      typeof subscription.items?.data?.[0]?.price?.id === 'string'
        ? subscription.items.data[0].price.id
        : null;

    const matchedPlan = await this.resolvePlanFromStripePrice(stripePriceId);
    const matchedInterval = this.resolvePlanIntervalFromStripePrice(
      matchedPlan,
      stripePriceId,
    );
    const effectivePlan = matchedPlan ?? tenant.plan;
    const effectiveInterval =
      matchedInterval ?? tenant.planInterval ?? 'monthly';

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: 'active',
        subscriptionStatus: 'active',
        stripePriceId: stripePriceId ?? undefined,
        planId: matchedPlan?.id ?? undefined,
        planInterval: matchedInterval ?? undefined,
        currentPeriodStart: period.start
          ? new Date(period.start * 1000)
          : undefined,
        currentPeriodEnd: period.end ? new Date(period.end * 1000) : undefined,
      },
    });

    if (effectivePlan && tenant.users[0]) {
      await this.upsertSubscriptionPurchase({
        tenantId: tenant.id,
        userId: tenant.users[0].id,
        planId: effectivePlan.id,
        planName: effectivePlan.name,
        stripeSubscriptionId: subscriptionId,
        stripePriceId,
        interval: effectiveInterval,
        amount: this.resolvePlanAmount(effectivePlan, effectiveInterval),
        status: 'active',
        startedAt: period.start ? new Date(period.start * 1000) : new Date(),
        endedAt: period.end ? new Date(period.end * 1000) : null,
      });
    }
  }

  // ─── Admin Endpoints ─────────────────────────────────────────────────────────

  async getAdminSubscriptionStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenantId: true },
    });
    if (!user?.tenantId) {
      return {
        tenantId: null,
        plan: null,
        subscriptionStatus: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        planInterval: null,
        isActive: false,
        isExpired: false,
      };
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { plan: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const isExpired =
      tenant.currentPeriodEnd != null &&
      new Date(tenant.currentPeriodEnd).getTime() < Date.now();

    return {
      tenantId: tenant.id,
      plan: tenant.plan
        ? {
            id: tenant.plan.id,
            name: tenant.plan.name,
            priceMonthly: tenant.plan.priceMonthly,
            priceYearly: tenant.plan.priceYearly,
          }
        : null,
      subscriptionStatus: tenant.subscriptionStatus ?? null,
      currentPeriodStart: tenant.currentPeriodStart,
      currentPeriodEnd: tenant.currentPeriodEnd,
      planInterval: tenant.planInterval ?? null,
      isActive: tenant.subscriptionStatus === 'active' && !isExpired,
      isExpired,
    };
  }

  async getAdminSubscriptionHistory(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenantId: true },
    });
    if (!user?.tenantId) {
      return {
        tenantId: null,
        current: null,
      };
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { plan: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const isExpired =
      tenant.currentPeriodEnd != null &&
      new Date(tenant.currentPeriodEnd).getTime() < Date.now();

    const periodEnd = tenant.currentPeriodEnd
      ? new Date(tenant.currentPeriodEnd)
      : null;
    const daysLeft = periodEnd
      ? Math.max(
          0,
          Math.ceil((periodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
        )
      : null;

    const currentPurchase = await this.prisma.subscriptionPurchase.findFirst({
      where: {
        tenantId: tenant.id,
        status: 'active',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        amount: true,
        interval: true,
        startedAt: true,
        endedAt: true,
        status: true,
      },
    });

    const isSubscriptionActive =
      (tenant.subscriptionStatus === 'active' || tenant.status === 'active') &&
      !isExpired;

    const planAmount =
      currentPurchase?.amount ??
      (tenant.planInterval === 'yearly'
        ? tenant.plan?.priceYearly
        : tenant.plan?.priceMonthly) ??
      0;

    return {
      tenantId: tenant.id,
      current: {
        planName: tenant.plan?.name ?? null,
        subscriptionStatus: tenant.subscriptionStatus ?? null,
        planInterval: currentPurchase?.interval ?? tenant.planInterval ?? null,
        amount: planAmount,
        startDate:
          currentPurchase?.startedAt ?? tenant.currentPeriodStart ?? null,
        daysLeft: daysLeft ?? (isSubscriptionActive ? 30 : 0),
        currentPeriodEnd: tenant.currentPeriodEnd,
        isActive: isSubscriptionActive,
        isExpired,
        permissions: tenant.plan
          ? {
              support: tenant.plan.supportLevel ?? null,
              companies: {
                used: null,
                max: tenant.plan.maxCompanies ?? null,
                unlimited: tenant.plan.maxCompanies == null,
              },
              projects: {
                used: null,
                max: tenant.plan.maxProjects ?? null,
                unlimited: tenant.plan.maxProjects == null,
              },
              users: {
                used: null,
                max: tenant.plan.maxUsers ?? null,
                unlimited: tenant.plan.maxUsers == null,
              },
              features: {
                geofencing: tenant.plan.hasGeofencing,
                advancedReporting: tenant.plan.hasAdvancedReporting,
                customReporting: tenant.plan.hasCustomReporting,
                whiteLabel: tenant.plan.hasWhiteLabel,
              },
            }
          : null,
      },
    };
  }

  // ─── In-App Mobile Subscription API ──────────────────────────────────────────

  async createMobileSubscription(userId: string, dto: MobileSubscribeDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user || user.role !== 'admin' || user.status !== 'active') {
      throw new ForbiddenException(
        'Only active admin users can purchase subscriptions',
      );
    }

    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: dto.planId },
    });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    if (!plan.isActive)
      throw new BadRequestException('This plan is not currently available');
    if (plan.visibility !== 'public')
      throw new BadRequestException('This plan is private and must be assigned by an admin');

    const tenant = user.tenantId
      ? await this.prisma.tenant.findUnique({
          where: { id: user.tenantId },
          include: { plan: true },
        })
      : null;

    if (tenant) {
      const isSamePlanActive =
        tenant.subscriptionStatus === 'active' &&
        tenant.planId === plan.id &&
        tenant.planInterval === dto.interval &&
        tenant.currentPeriodEnd != null &&
        new Date(tenant.currentPeriodEnd).getTime() > Date.now();

      if (isSamePlanActive) {
        throw new BadRequestException(
          'You already have an active subscription for this plan and billing cycle.',
        );
      }

      // Check if switching back to an already paid plan that is still within valid period
      const previousPurchase = await this.prisma.subscriptionPurchase.findFirst(
        {
          where: {
            tenantId: tenant.id,
            planId: plan.id,
            interval: dto.interval,
            status: 'active',
            stripeSubscriptionId: { not: null },
            endedAt: { gt: new Date() },
          },
        },
      );

      if (previousPurchase?.stripeSubscriptionId) {
        const switchResult = await this.switchToExistingSubscription({
          tenant,
          plan,
          interval: dto.interval,
          targetSubscriptionId: previousPurchase.stripeSubscriptionId,
        });
        return {
          ...switchResult,
          requiresPayment: false,
        };
      }
    }

    // 1. Create or get tenant
    const activeTenant =
      tenant ??
      (await this.prisma.tenant.create({
        data: {
          name: user.fullName || user.email.split('@')[0] || 'New Tenant',
          billingEmail: user.email,
          planId: plan.id,
          status: 'trial',
          subscriptionStatus: 'pending',
          planInterval: dto.interval,
        },
      }));

    if (!user.tenantId) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { tenantId: activeTenant.id },
      });
    }

    // 2. Stripe Customer
    let customer: any;
    if (activeTenant.stripeCustomerId) {
      try {
        customer = await this.stripe.customers.retrieve(
          activeTenant.stripeCustomerId,
        );
      } catch {
        customer = await this.stripe.customers.create({
          email: activeTenant.billingEmail || user.email,
          name: activeTenant.name,
          metadata: { tenantId: activeTenant.id, adminUserId: user.id },
        });
        await this.prisma.tenant.update({
          where: { id: activeTenant.id },
          data: { stripeCustomerId: customer.id },
        });
      }
    } else {
      customer = await this.stripe.customers.create({
        email: activeTenant.billingEmail || user.email,
        name: activeTenant.name,
        metadata: { tenantId: activeTenant.id, adminUserId: user.id },
      });
      await this.prisma.tenant.update({
        where: { id: activeTenant.id },
        data: { stripeCustomerId: customer.id },
      });
    }

    // 3. Ephemeral key for PaymentSheet
    const ephemeralKey = await this.stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2026-04-22.dahlia' as any },
    );

    // 4. Ensure plan prices exist
    const syncedPlan = await this.ensurePlanStripePrices(plan);
    const priceId =
      dto.interval === 'yearly'
        ? (syncedPlan.stripePriceYearlyId ?? syncedPlan.stripePriceMonthlyId)
        : syncedPlan.stripePriceMonthlyId;

    if (!priceId) {
      throw new BadRequestException(
        'Stripe price not configured for this plan',
      );
    }

    // 5. Create Stripe Subscription with default_incomplete
    const subscription = await this.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        tenantId: activeTenant.id,
        planId: plan.id,
        adminUserId: user.id,
        interval: dto.interval,
        source: 'mobile_in_app',
      },
    });

    if (subscription.status === 'active') {
      await this.prisma.tenant.update({
        where: { id: activeTenant.id },
        data: {
          stripePriceId: priceId,
          planId: plan.id,
          planInterval: dto.interval,
          subscriptionStatus: 'ACTIVE',
          status: 'active',
        },
      });

      return {
        requiresPayment: false,
        subscriptionId: subscription.id,
        message: 'Subscription activated successfully!',
      };
    }

    const invoice = subscription.latest_invoice as any;
    const invoiceId = typeof invoice === 'string' ? invoice : invoice?.id;

    let clientSecret: string | undefined;

    // 1. Try from expanded invoice.payment_intent
    if (invoice && typeof invoice === 'object') {
      if (typeof invoice.payment_intent === 'string') {
        try {
          const pi = await this.stripe.paymentIntents.retrieve(
            invoice.payment_intent,
          );
          clientSecret = pi.client_secret ?? undefined;
        } catch (e) {
          console.warn('Failed to retrieve payment intent by invoice id:', e);
        }
      } else if (invoice.payment_intent?.client_secret) {
        clientSecret = invoice.payment_intent.client_secret;
      }
    }

    // 2. Try looking up the customer's recent PaymentIntents
    if (!clientSecret && customer.id) {
      try {
        const paymentIntents = await this.stripe.paymentIntents.list({
          customer: customer.id,
          limit: 5,
        });
        const matchedPi = paymentIntents.data.find(
          (pi: any) =>
            (invoiceId &&
              (pi.payment_details?.order_reference === invoiceId ||
                pi.invoice === invoiceId)) ||
            pi.status === 'requires_payment_method' ||
            pi.status === 'requires_action' ||
            pi.status === 'requires_confirmation',
        );
        if (matchedPi?.client_secret) {
          clientSecret = matchedPi.client_secret;
        }
      } catch (err) {
        console.warn('Failed to list payment intents for customer:', err);
      }
    }

    // 3. Try setup intent if applicable (for free trial or $0 invoice)
    if (!clientSecret && subscription.pending_setup_intent) {
      try {
        const setupIntent =
          typeof subscription.pending_setup_intent === 'string'
            ? await this.stripe.setupIntents.retrieve(
                subscription.pending_setup_intent,
              )
            : subscription.pending_setup_intent;
        clientSecret = setupIntent.client_secret ?? undefined;
      } catch (err) {
        console.warn('Failed to retrieve setup intent:', err);
      }
    }

    if (!clientSecret) {
      throw new BadRequestException(
        'Unable to generate payment client secret for subscription',
      );
    }

    await this.prisma.tenant.update({
      where: { id: activeTenant.id },
      data: {
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId,
        planId: plan.id,
        planInterval: dto.interval,
      },
    });

    return {
      requiresPayment: true,
      subscriptionId: subscription.id,
      paymentIntentClientSecret: clientSecret.startsWith('pi_')
        ? clientSecret
        : undefined,
      setupIntentClientSecret: clientSecret.startsWith('seti_')
        ? clientSecret
        : undefined,
      customerEphemeralKeySecret: ephemeralKey.secret,
      customerId: customer.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    };
  }

  async confirmMobileSubscription(userId: string, dto: MobileConfirmDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException('Unauthorized');
    }

    const subscription = await this.syncTenantFromStripeSubscription(
      dto.subscriptionId,
      user.tenantId ?? undefined,
    );
    if (!subscription) {
      throw new NotFoundException(
        'Subscription sync failed or tenant not found',
      );
    }

    return {
      success: true,
      subscriptionStatus: subscription.status,
      message: 'Subscription successfully confirmed and activated',
    };
  }
}
