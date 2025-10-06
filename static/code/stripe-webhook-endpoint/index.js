import { Handler } from './handlers'

export default (router, { services, exceptions, database, schema, logger }) => {
  const { ItemsService, MailService } = services
  const { ServiceUnavailableException } = exceptions

  const stripe = require('stripe')('sk_test_SOMTHING')
  const endpointSecret = 'whsec_SOMETHING'

  router.post('/', async (req, res) => {
    let event = req.rawBody
    // Only verify the event if you have an endpoint secret defined.
    // Otherwise use the basic event deserialized with JSON.parse
    if (endpointSecret) {
      // Get the signature sent by Stripe
      const signature = req.headers['stripe-signature']
      try {
        event = stripe.webhooks.constructEvent(req.rawBody, signature, endpointSecret)
      } catch (err) {
        console.log(`⚠️  Webhook signature verification failed.`, err.message)
        return res.sendStatus(400)
      }
    } else return // kill the endpoint if no endpoint Secret

    const mailer = new MailService({ schema, knex: database })
    const customerDetailsService = new ItemsService('customer_details', {
      schema: req.schema,
    })
    const customerSubscriptionService = new ItemsService('customer_subscriptions', {
      schema: req.schema,
      accountability: {
        role: 'admin',
        admin: true,
      },
    })
    const subscriptionItemService = new ItemsService('subscription_items', {
      schema: req.schema,
      accountability: {
        role: 'admin',
        admin: true,
      },
    })
    const handler = new Handler(
      logger,
      customerDetailsService,
      customerSubscriptionService,
      subscriptionItemService,
      mailer,
      ServiceUnavailableException
    )

    var handlerRes = false

    // Handle the event
    console.log('Event: ', event.type)
    switch (event.type) {
      case 'customer.subscription.created':
        // OK: add customer_subscriptions in trialing.
        const subscriptionCreated = event.data.object
        handlerRes = await handler.handleSubscriptionCreated(subscriptionCreated)

        if (handlerRes)
          logger.info(
            `Creating a Subscription object for ${subscriptionCreated.customer}
            was successful!`
          )
        else
          logger.info(
            `Problem during the process of subscription creation for
            ${subscriptionCreated.customer}.`
          )
        break
      case 'invoice.paid':
        // OK: Confirm the status of the subscription.
        const invoicePaid = event.data.object

        handlerRes = await handler.handleInvoicePaid(invoicePaid)

        if (handlerRes)
          logger.info(
            `Update the subscription' status for customerId ${invoicePaid.customer}
            to active`
          )
        else
          logger.info(
            `Problem during the subscription' status update for customerId ${invoicePaid.customer}
            to active`
          )
        break
      case 'invoice.payment_action_required':
        // Block subscription + send email to admin
        const invoicePaymentActionRequired = event.data.object
        handlerRes = await handler.handleInvoicePaymentActionRequired(invoicePaymentActionRequired)

        if (handlerRes)
          logger.info(
            `Update the subscription' status for customerId ${invoicePaymentActionRequired.customer}
            to incomplete.`
          )
        else
          logger.info(
            `Problem during the subscription' status update for customerId ${invoicePaymentActionRequired.customer}
            to incomplete.`
          )
        break
      case 'customer.subscription.deleted':
        // Update subscription status and send an email to the user.
        const subscriptionDeleted = event.data.object
        handlerRes = await handler.handleSubscriptionDeleted(subscriptionDeleted)

        if (handlerRes)
          logger.info(
            `Update the subscription' status for customerId ${subscriptionDeleted.customer}
            to cancelled`
          )
        else
          logger.info(
            `Problem during the subscription' status update for customerId ${subscriptionDeleted.customer}
            to cancelled`
          )
        break
      case 'customer.subscription.trial_will_end':
        // Send email when trial is going to end.
        const subscriptionTrialWillEnd = event.data.object
        handlerRes = await handler.handleSubscriptionTrialWillEnd(subscriptionTrialWillEnd)

        if (handlerRes)
          logger.info(`Send email to ${subscriptionTrialWillEnd.customer}. Trial will end soon.`)
        else
          logger.info(
            `Problem during email sending to customerId ${subscriptionTrialWillEnd.customer}
            for trialing period ending soon.`
          )
        break
      case 'customer.subscription.updated':
        // Update the subscription type.
        const subscriptionUpdated = event.data.object
        handlerRes = await handler.handleSubscriptionUpdated(subscriptionUpdated)

        if (handlerRes)
          logger.info(`Customer ${subscriptionUpdated.customer}. Subscription updated properly.`)
        else
          logger.info(
            `Problem with Customer ${subscriptionUpdated.customer} when updating subscription.`
          )
        break
      default:
        // Unexpected event type
        console.log(`Unhandled event type ${event.type}.`)
        console.log(event.data.object)
    }

    // Return a 200 response to acknowledge receipt of the event
    res.sendStatus(200)
  })
}
