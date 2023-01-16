export class Handler {
  constructor(
    logger,
    customerDetailsService,
    customerSubscriptionService,
    subscriptionItemService,
    mailService,
    ServiceUnavailableException
  ) {
    this.logger = logger
    this.customerDetailsService = customerDetailsService
    this.customerSubscriptionService = customerSubscriptionService
    this.subscriptionItemService = subscriptionItemService
    this.mailService = mailService
    this.ServiceUnavailableException = ServiceUnavailableException

    return this
  }

  async getCustomerDetails(stripe_customer_id) {
    // Retrieve the customer details ID from the stripe customer ID.
    return await this.customerDetailsService
      .readByQuery({
        filter: { stripe_id: { _eq: stripe_customer_id } },
        fields: ['*', 'user_id.first_name', 'user_id.email'],
      })
      .then((results) => results[0])
      .catch((error) => {
        console.log('getCustomerDetails error', error.message)
      })
  }

  async getCustomerSubscription(customer_details_id) {
    // Verifies if a CustomerSubscription exists based on a customer_details id.
    // if it does, return the customerSubscription, else, return null.
    return await this.customerSubscriptionService
      .readByQuery({
        filter: { customer_details: { _eq: customer_details_id } },
        fields: ['*'],
      })
      .then((results) => results)
      .catch((error) => {
        console.log('getCustomerSubscription error', error.message)
      })
  }

  async getSubscriptionItemFromId(item_id) {
    // Get the subscription item data.
    return await this.subscriptionItemService
      .readByQuery({
        filter: { id: { _eq: item_id } },
        fields: ['*'],
      })
      .then((results) => {
        return results[0]
      })
      .catch((error) => {
        console.log('getSubscriptionItem error', error.message)
      })
  }

  async getSubscriptionItemFromPriceId(item_price_id) {
    // Get the subscription item data.
    return await this.subscriptionItemService
      .readByQuery({
        filter: { stripe_price_id: { _eq: item_price_id } },
        fields: ['*'],
      })
      .then((results) => {
        return results[0]
      })
      .catch((error) => {
        console.log('getSubscriptionItem error', error.message)
      })
  }

  getDateToString(date) {
    // something like 2022-10-31T15:15:12.914Z
    let isoDate = date.toISOString()
    // return : 2022-10-31 15:15
    return isoDate.replace('T', ' ').replace('Z', '').substring(0, 16)
  }

  async handleSubscriptionCreated(data) {
    // A subscription is created. Since, we are using trial periods,
    // we start with this webhook to create a subscription.
    console.log('Enter: handleSubscriptionCreated')
    try {
      const customerDetails = await this.getCustomerDetails(data.customer)
      const customerSubscription = await this.getCustomerSubscription(customerDetails.id)
      const subscriptionItem = await this.getSubscriptionItemFromPriceId(data.plan.id)

      const trialEnd = this.getDateToString(new Date(data.trial_end * 1000))

      try {
        if (customerSubscription.length == 0) {
          console.log(`No data in DB for ${customerDetails.id}.`)
          // The subscription status will be set to the default
          // value in DB (here "trialing").
          this.customerSubscriptionService.createOne({
            customer_details: customerDetails.id,
            subscription_items: subscriptionItem.id,
            trial_ends_at: trialEnd,
          })
        } else {
          console.log(`A row already exists for customer_subscriptions ${customerDetails.id}.`)
          console.log(`Update stripe_subscription_status to ${data.status}`)
          var item = {
            stripe_subscription_status: data.status,
          }
          // Compare with our DB record
          // Do nothing or get the plan relative to the new price_id.
          if (customerSubscription[0].subscription_items.id !== subscriptionItem.id) {
            // Not the correct plan !
            item.subscription_items = subscriptionItem.id
          }

          if (data.status === 'trialing') {
            console.log(`End trial period set to ${trialEnd}.`)
            item.trial_ends_at = trialEnd
            item.ends_at = null
          }

          this.customerSubscriptionService.updateOne(customerSubscription[0].id, item)
        }
      } catch (error) {
        console.log(error)
        console.log('Exit with error for creation: handleCheckoutSessionCompleted')
        return false
      }

      // Send the email if it's the first time the customer subscribe.
      if (customerSubscription.length == 0) {
        try {
          console.log('Send mail to ', customerDetails.user_id.email)
          await this.mailService.send({
            to: customerDetails.user_id.email,
            bcc: 'mymail@mail.com',
            subject: 'Bienvenue !',
            template: {
              name: 'subscription-started',
              data: {
                firstName: customerDetails.user_id.first_name,
                trialEnd: trialEnd,
                daysOfTrial: subscriptionItem.days_of_trial,
              },
            },
          })

          console.log('Send mail to admin')
          await this.mailService.send({
            to: 'admin@website.com',
            subject: 'New subscription created',
            template: {
              name: 'admin-new-subscription',
              data: {
                eventName: 'customer.subscription.created',
                customerId: customerDetails.user_id.id,
                customerEmail: customerDetails.user_id.email,
                trialEnd: trialEnd,
                daysOfTrial: subscriptionItem.days_of_trial,
                action: 'Create new customer_subscriptions row in table.',
              },
            },
          })
        } catch (error) {
          console.log(error)
          console.log('Exit with error for mail: handleSubscriptionCreated')
          return false
        }
      }
    } catch (error) {
      console.log(error)
      console.log('Exit with error when getting items in DB: handleSubscriptionCreated')
      return false
    }

    console.log('Exit with no error: handleSubscriptionCreated')
    return true
  }

  async handleInvoicePaid(data) {
    // Allow the customer to access our data, by updating "stripe_status"
    // in the customer_subscriptions table to active.
    // If trialing + trial_ends_at < invoice.created => stripe_status = active
    // Else => do nothing (it's the first invoice)

    console.log('Enter: handleInvoicePaid')
    try {
      // Retrieve the correct customer_subscriptions row.
      const customerDetails = await this.getCustomerDetails(data.customer)
      const customerSubscription = await this.getCustomerSubscription(customerDetails.id)

      if (customerSubscription.length == 0) {
        // There is no customerSubscription item yet. It means it's the first
        // invoice for the trial period.
        // customerSubscription item creation is handled with the webhook
        // customer.subscription.created
        console.log('There is no customerSubscription item yet.')
        return true
      }

      if (customerSubscription[0].stripe_subscription_status == 'trialing') {
        if (new Date(customerSubscription[0].trial_ends_at) <= new Date(data.created * 1000)) {
          console.log('Trial period is over. The customer just paid.')
        } else {
          console.log('Trial period is not over yet. This should not happen.')
          await this.mailService.send({
            to: 'mail@mail.fr',
            subject: 'Log Stripe: Invoice paid BUT',
            template: {
              name: 'admin-warning',
              data: {
                eventName: 'invoice.paid',
                customerEmail: customerDetails.user_id.email,
                action:
                  'An invoice has been paid but something went wrong anyway. Check this customer.',
                invoiceId: data.id,
              },
            },
          })
          return true
        }
      }

      console.log('Update stripe_subscription_status to active.')
      // We do not modify the end date of the subscription because we do not
      // have the info in the data received. This is done in the
      // customer.subscription.update webhook handling.
      var item = {
        stripe_subscription_status: 'active',
      }
      this.customerSubscriptionService.updateOne(customerSubscription[0].id, item)

      console.log('Exit with no error: handleInvoicePaid')
      return true
    } catch (error) {
      console.log('Exit with error: handleInvoicePaid')
      console.log(error)
      return false
    }
  }

  async handleInvoicePaymentActionRequired(data) {
    // Problem with a payment. We inform admin + customer via email.
    console.log('Enter: handleInvoicePaymentActionRequired')
    try {
      // Retrieve the correct customer_subscriptions row.
      const customerDetails = await this.getCustomerDetails(data.customer)
      const customerSubscription = await this.getCustomerSubscription(customerDetails.id)

      // Do an action only if a Subscription already exists for the user
      if (customerSubscription.length > 0) {
        console.log(`Payment Action required for ${customerDetails.user_id.email}`)

        try {
          // Send email to client
          console.log('Send mail to ', customerDetails.user_id.email)
          await this.mailService.send({
            to: customerDetails.user_id.email,
            subject: 'Waiting for payment',
            template: {
              name: 'payment-required',
              data: {
                firstName: customerDetails.user_id.first_name,
              },
            },
          })

          // Send email to admin to put a warning
          await this.mailService.send({
            to: 'you@mail.com',
            subject: 'Log Stripe: payment_action_required',
            template: {
              name: 'admin-warning',
              data: {
                eventName: 'invoice.payment_action_required',
                userEmail: customerDetails.user_id.email,
                action: `Problem with payment.`,
                invoiceId: data.id,
              },
            },
          })
        } catch (error) {
          console.log(error)
          console.log('Exit with error for mail: handleInvoicePaymentActionRequired')
          return false
        }
      }

      console.log('Exit with no error: handleInvoicePaymentActionRequired')
      return true
    } catch (error) {
      console.log('Exit with error: handleInvoicePaymentActionRequired')
      console.log(error)
      return false
    }
  }

  async handleSubscriptionUpdated(data) {
    // Occurs whenever a subscription changes (e.g., switching from one plan to
    // another, or changing the status from trial to active).
    // Also gives the end date of the current subscription !
    console.log('Enter: handleSubscriptionUpdated')
    const customerDetails = await this.getCustomerDetails(data.customer)
    const customerSubscription = await this.getCustomerSubscription(customerDetails.id)

    // Update the records in DB.
    // If the subscription is switched to active, it means the customer just
    // paid so we can use the current_period_end to know until when the
    // subscription is active.
    // If the subscription status is switched to past_due, incomplete, or
    // cancelled, we do not want to register the end-date, that needs to be the
    // last current_period_end associated with a status="active".
    console.log(`Update stripe_subscription_status to ${data.status}`)
    var item = {
      stripe_subscription_status: data.status,
    }
    // Parse response to know if there is a plan switch
    // Get the price_id of the plan
    const subscriptionItem = await this.getSubscriptionItemFromPriceId(data.plan.id)
    // Compare with our DB record
    // Do nothing or get the plan relative to the new price_id.
    if (customerSubscription[0].subscription_items.id !== subscriptionItem.id) {
      // Not the correct plan !
      item.subscription_items = subscriptionItem.id
    }

    if (data.status === 'active') {
      const endsAt = this.getDateToString(new Date(data.current_period_end * 1000))
      console.log(`End period set to ${endsAt}.`)
      item.ends_at = endsAt
    }

    this.customerSubscriptionService.updateOne(customerSubscription[0].id, item)

    // Send the email to admin
    try {
      console.log('Send mail to XXX@mail.com')
      let message = `Status changed for ${customerDetails.user_id.email}
               into ${data.status}.`
      // Customer cancelled during the trial period.
      if (data.cancel_at_period_end)
        message = `${customerDetails.user_id.email} cancelled during trial.`
      await this.mailService.send({
        to: 'XXX@mail.com',
        subject: 'Log Stripe: subscription update',
        template: {
          name: 'admin-warning',
          data: {
            eventName: 'customer.subscription.updated',
            customerEmail: customerDetails.user_id.email,
            action: message,
            invoiceId: '',
          },
        },
      })
    } catch (error) {
      console.log(error)
      console.log('Exit: handleSubscriptionUpdated')
      return false
    }

    console.log('Exit: handleSubscriptionUpdated')
    return true
  }

  async handleSubscriptionTrialWillEnd(data) {
    // Webhook that informs us that in 3 days the trial will end.
    // We should send a mail to the customer and to admin to
    // inform us.
    console.log('Enter: handleSubscriptionTrialWillEnd')
    // Send the email to admin
    try {
      const customerDetails = await this.getCustomerDetails(data.customer)
      const customerSubscription = await this.getCustomerSubscription(customerDetails.id)

      const subscriptionItem = await this.getSubscriptionItemFromId(
        customerSubscription[0].subscription_items
      )

      console.log('Send mail to ', customerDetails.user_id.email)
      // parameters are based on yearly service directly
      let period = 'annuel'
      let pricePerPeriod = `${subscriptionItem.stripe_price} € HT par an`
      let engagement = 'engagement sur un an'
      if (subscriptionItem.billing_interval == 'month') {
        period = 'mensuel'
        pricePerPeriod = `${subscriptionItem.stripe_price} € HT par mois`
        engagement = 'sans engagement'
      }
      // No end of trial period, so we expect the customer to pay in 3 days.
      if (data.cancel_at_period_end === false) {
        await this.mailService.send({
          to: customerDetails.user_id.email,
          subject: "Votre période d'essai se termine dans 3j",
          template: {
            name: 'trial-end-soon',
            data: {
              firstName: customerDetails.user_id.first_name,
              daysOfTrial: subscriptionItem.days_of_trial,
              period: period,
              engagement: engagement,
              pricePerPeriod: pricePerPeriod,
            },
          },
        })

        // Send mail to admin
        console.log('Send mail to admin')
        await this.mailService.send({
          to: 'admin@something.fr',
          subject: 'Log Stripe: trial will end',
          template: {
            name: 'admin-warning',
            data: {
              eventName: 'customer.subscription.trial_will_end',
              customerEmail: customerDetails.user_id.email,
              action: "Vérifier que le mail de fin de période d'essai a bien été envoyé.",
              invoiceId: '',
            },
          },
        })
      } else {
        // Send mail to admin, the client will stop.
        await this.mailService.send({
          to: 'admin@something.fr',
          subject: 'Log Stripe: trial will end - cancelled',
          template: {
            name: 'admin-warning',
            data: {
              eventName: 'customer.subscription.trial_will_end',
              customerEmail: customerDetails.user_id.email,
              action:
                "Client cancelled subscription before the end of the trial. She shouldn't receive any email.",
              invoiceId: '',
            },
          },
        })
      }
    } catch (error) {
      console.log(error)
      console.log('Exit: handleSubscriptionTrialWillEnd')
      return false
    }

    console.log('Exit: handleSubscriptionTrialWillEnd')
    return true
  }

  async handleSubscriptionDeleted(data) {
    // Webhook that informs us that the subscription has been cancelled.
    // We should update the stripe_subscription_status to cancelled.
    // We should send a mail to the customer and to admin to
    // inform us.

    console.log('Enter: handleSubscriptionDeleted')
    // Send the email to admin
    try {
      const customerDetails = await this.getCustomerDetails(data.customer)
      const customerSubscription = await this.getCustomerSubscription(customerDetails.id)

      var item = {
        stripe_subscription_status: 'cancelled',
        ends_at: customerSubscription[0].ends_at,
      }

      // If the subscription was past_due or incomplete or in trial, then switch to cancelled
      // because of non payment, we want to be sure that the endDate is now.
      if (
        ['trialing', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid'].includes(
          customerSubscription[0].stripe_subscription_status
        )
      ) {
        console.log(`End period set to NOW: ${this.getDateToString(new Date())}.`)
        item.ends_at = this.getDateToString(new Date())
      }

      // Update stripe_subscription_status to cancelled.
      console.log('Update stripe_subscription_status to cancelled.')
      this.customerSubscriptionService.updateOne(customerSubscription[0].id, item)

      console.log('Send mail to ', customerDetails.user_id.email)
      await this.mailService.send({
        to: customerDetails.user_id.email,
        subject: 'Votre abonnement est terminé',
        template: {
          name: 'subscription-deleted',
          data: {
            firstName: customerDetails.user_id.first_name,
            endDate: item.ends_at,
          },
        },
      })

      // Send mail to admin
      console.log('Send mail to admin')
      await this.mailService.send({
        to: 'admin@something.fr',
        subject: 'Log Stripe: subscription deleted',
        template: {
          name: 'admin-warning',
          data: {
            eventName: 'customer.subscription.deleted',
            customerEmail: customerDetails.user_id.email,
            action: `Subscription will stop at: ${item.ends_at}`,
            invoiceId: '',
          },
        },
      })
    } catch (error) {
      console.log(error)
      console.log('Exit: handleSubscriptionDeleted')
      return false
    }

    console.log('Exit: handleSubscriptionDeleted')
    return true
  }
}
