import type { HelpArticle } from "./types";

/**
 * Help Center articles (master plan B65). Each article was checked against the page, its components and its server
 * actions on the `reviewed` date: labels are the ones shown in the app, troubleshooting quotes the messages people
 * actually see, and anything that needs a database update, a provider or a setting is stated as a limitation.
 */
const REVIEWED = "2026-10-20";

export const HELP_ARTICLES: HelpArticle[] = [
  // ---------------------------------------------------------------------------------------------------------------
  // Getting started
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "getting-started",
    title: "Finding your way around Taviron",
    summary: "How the menu, the Command Center, the profile menu, appearance settings and help fit together.",
    category: "getting-started",
    routes: ["/command-center", "/profile"],
    permissions: [],
    audience: "Everyone who signs in to a company workspace.",
    whatYouSee: [
      "A menu on the left with the pages your role can open, grouped under Sales, Operations, Finance and Company. Pages your role cannot use are not listed.",
      "On a computer the menu shows icons only until you point at it; **Keep sidebar open** pins it open and **Unpin sidebar** returns it to icons.",
      "On a phone or small screen, **Open menu** (top left) shows the same menu.",
      "Your company's name or logo at the top of the menu; selecting it takes you home to the Command Center (drivers start on My Day).",
      "Your name and role at the top right. Selecting them opens the profile menu: **My profile**, **Company setup** (administrators), the companies you belong to, **Appearance** and **Sign out**.",
      "In a demo company, a Demo label next to your name and the extra menu items **Change view**, **About this demo** and **Presentation mode**. Demo data is fictional and nothing is sent.",
    ],
    tasks: [
      {
        title: "Switch between light and dark mode",
        steps: [
          "Select your name at the top right.",
          "Under **Appearance**, choose **Light**, **Dark** or **Match my device**.",
          "The choice applies right away.",
        ],
      },
      {
        title: "Switch to another company",
        steps: [
          "Select your name at the top right.",
          "Under **Companies**, select the company you want. This list appears only when you belong to more than one company.",
        ],
      },
      {
        title: "Get help for the page you are on",
        steps: [
          "Select the question-mark button (**Help for this page**).",
          "Articles for the current page are listed first under **On this page**.",
          "Type in **Search help…** to find other articles.",
        ],
      },
      {
        title: "Sign out",
        steps: ["Select your name at the top right.", "Select **Sign out**."],
      },
    ],
    prerequisites: ["An owner or administrator must give your sign-in a role before you can see company data."],
    troubleshooting: [
      {
        problem: "You see “Your account is waiting for access”.",
        fix: "You are signed in, but nobody has given you a role in a company yet. Ask your company's owner to assign one on People → Sign-ins & roles.",
      },
      {
        problem: "You see “You do not have access to that page”.",
        fix: "Your role does not include that page. Use the menu for the pages you can open, or ask an owner to change your role or permissions.",
      },
      {
        problem: "A page you expect is missing from the menu.",
        fix: "The menu only lists pages your role can use. An owner can change what each role can do in Settings → Roles and permissions.",
      },
      {
        problem: "An action says “You do not have permission to perform this action”.",
        fix: "You can open the page but not make that change. Ask someone with the permission, or ask an owner to grant it to your role.",
      },
    ],
    next: ["command-center", "profile"],
    related: ["company-setup", "settings-roles-permissions"],
    reviewed: REVIEWED,
  },
  {
    id: "command-center",
    title: "Command Center",
    summary: "One home page with what needs attention today, your own items, the next 7 days and recent activity.",
    category: "getting-started",
    routes: ["/command-center", "/dashboard"],
    permissions: ["dispatch.view", "tickets.view", "billing.view", "fleet.view", "field_reports.view", "orders.view", "quotes.view"],
    audience: "Owners, office staff, dispatchers and anyone with orders, dispatch, tickets, billing, fleet, driver reports or quotes in their role.",
    whatYouSee: [
      "**Next 7 days** (with dispatch access): loads per day, loads without a truck and conflicts. Estimated value is shown only to people who can see billing.",
      "**Your work**: items someone assigned to you and, if your sign-in is also linked to a driver, your own loads today.",
      "**Attention queue**: one item per open problem, most urgent and oldest first, such as Urgent order, Needs a delivery date, Load without a truck, Missing delivery ticket, Ticket to review, Billing blocked, Equipment out of service and driver reports.",
      "**Operations today**, **Sales and quotes** (with quote access) and **Recent activity**, depending on your role.",
      "An item leaves the queue only when its record is fixed on its own page; hiding or assigning it never closes it.",
    ],
    tasks: [
      {
        title: "Assign an item to someone",
        steps: [
          "In the **Attention queue**, select **Assign** on the item (or **Reassign** if someone already has it).",
          "Choose the **Person** and add a **Note (optional)**.",
          "Select **Assign**. The item shows under **Assigned to me** for that person.",
        ],
      },
      {
        title: "Hide an item from your own view for a while",
        steps: [
          "Select **Hide for me** on a non-urgent item.",
          "Choose **For 4 hours**, **For 1 day** or **For 3 days**.",
          "The problem stays open for everyone else. Use the **Hidden by you** filter to see it again.",
        ],
      },
      {
        title: "Arrange the sections",
        steps: [
          "Select **Arrange sections**.",
          "Move sections up or down, then select **Done arranging**. The order is saved for you only.",
        ],
      },
      {
        title: "See the latest figures",
        steps: ["Select **Refresh** at the top of the page."],
      },
    ],
    prerequisites: ["Assigning items needs the permission to assign exceptions."],
    troubleshooting: [
      {
        problem: "A section says it “could not be loaded”.",
        fix: "No figures are shown rather than guessed. Select **Try again**, or open the module directly (Dispatch, Delivery Tickets, Billing).",
      },
      {
        problem: "Assigning says the person cannot resolve this item.",
        fix: "Each kind of item needs a role that can fix it (for example dispatch for loads without a truck). Choose someone whose role covers it.",
      },
      {
        problem: "An item stays in the queue after you looked at it.",
        fix: "Items close only when the underlying record is fixed, for example when the load gets a truck or the ticket is accepted. Open the item and fix it on its own page.",
      },
      {
        problem: "You land on My Day instead of the Command Center.",
        fix: "Sign-ins whose only responsibility is driving start on My Day. If you also do office work, ask an owner to check your role.",
      },
    ],
    next: ["dispatch-board", "delivery-tickets"],
    related: ["getting-started", "order-to-cash", "driver-reports"],
    reviewed: REVIEWED,
  },
  {
    id: "company-setup",
    title: "Company setup checklist",
    summary: "See what Taviron still needs before its checks, dispatch suggestions and plans can rely on your data.",
    category: "getting-started",
    routes: ["/setup"],
    permissions: ["settings.manage"],
    audience: "Owners and administrators setting up the company.",
    whatYouSee: [
      "A count of steps complete and one card per step: Company profile, People and roles, Customers, Materials and rates, Trucks and capacity, Trailers, Drivers and qualifications.",
      "Each step shows **Done**, **Incomplete** or **Not started**, what is missing and why it matters.",
      "A link on each unfinished step to the page where you add or fix the records.",
      "An **AI capabilities** section showing each AI feature as Ready, Limited, Needs review or Blocked.",
    ],
    tasks: [
      {
        title: "Open the checklist",
        steps: ["Select your name at the top right.", "Select **Company setup**."],
      },
      {
        title: "Finish a step",
        steps: [
          "Find a step marked **Incomplete** or **Not started**.",
          "Select its **Start …** or **Complete …** link.",
          "Add or fix the records on that page, then come back to the checklist.",
        ],
      },
    ],
    prerequisites: ["Needs the permission to manage company settings."],
    troubleshooting: [
      {
        problem: "“The checklist could not be loaded right now.”",
        fix: "Nothing was changed. Try again in a moment.",
      },
      {
        problem: "An AI feature shows Needs review or Blocked.",
        fix: "An AI feature never runs until the owner turns it on with its own settings and passing evaluations. The rest of Taviron works the same without it.",
      },
    ],
    next: ["settings-company", "people"],
    related: ["getting-started", "fleet-trucks", "customers"],
    reviewed: REVIEWED,
    limitations: ["The checklist only reads your data; it never changes a record. Importing records from spreadsheets is done by Taviron's onboarding team, not on this page."],
  },
  {
    id: "profile",
    title: "My profile",
    summary: "Change the name and photo others see, your phone number, and request a password reset.",
    category: "getting-started",
    routes: ["/profile"],
    permissions: [],
    audience: "Everyone.",
    whatYouSee: [
      "**Photo**: your profile photo, or initials when there is none, with an option to choose an illustrated avatar.",
      "**Your details**: **Name to show** and **Phone**.",
      "**Managed by your company**: your full name on record, company, role and sign-in. Ask your company administrator to change these.",
      "**Change password (sends a reset link)**.",
    ],
    tasks: [
      {
        title: "Add or change your photo",
        steps: [
          "Select **Add a photo** (or **Change photo**).",
          "Choose a JPEG, PNG, WebP or phone camera picture.",
          "Zoom and move it in the preview, then select **Save photo**. Nothing is sent before you save.",
        ],
      },
      {
        title: "Change the name others see",
        steps: ["Enter the **Name to show**.", "Select **Save**."],
      },
      {
        title: "Change your password",
        steps: ["Select **Change password (sends a reset link)**.", "Follow the link in the email to choose a new password."],
      },
    ],
    prerequisites: [],
    troubleshooting: [
      { problem: "“That file is larger than 15 MB. Choose a smaller photo.”", fix: "Choose a smaller picture, or take a new one with lower resolution." },
      { problem: "“That picture could not be read. Try a JPEG or PNG photo.”", fix: "Some formats cannot be read in the browser. Save the picture as JPEG or PNG and try again." },
      { problem: "“Enter the whole number, e.g. (312) 555-0142, or leave it empty.”", fix: "Enter the full phone number including area code, or clear the field." },
      { problem: "“Profile editing is not available yet”.", fix: "The server has not been updated for profile photos and display names yet. Your account works as before." },
    ],
    next: ["getting-started"],
    related: ["people"],
    reviewed: REVIEWED,
    limitations: ["Your role, company access and full name on record are managed by your company administrator, not on this page."],
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Customers and CRM
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "customers",
    title: "Customers",
    summary: "Find, add and maintain customers and prospects, their contacts and their job sites.",
    category: "customers",
    routes: ["/customers", "/customers/new", "/customers/*"],
    permissions: ["customers.view"],
    audience: "Office staff, sales and owners.",
    whatYouSee: [
      "A searchable list of customers and prospects with filters for **Type**, **Status** and **Relationship**, and a **Sort** option.",
      "**New customer**, **Pipeline** and **Export CSV** buttons at the top.",
      "On a customer page: **Details** (main email and phone, billing address, payment terms, purchase orders, pricing, sales tax), **Quotes**, **Contacts** and **Delivery / job sites**.",
      "Buttons on the customer page for **New quote**, **New order**, **Edit** and **Archive** (depending on your role).",
      "A **Sample** badge on fictional training records.",
    ],
    tasks: [
      {
        title: "Create a customer",
        steps: [
          "Select **New customer**.",
          "Enter the **Customer name** and choose the **Type** (Commercial or Residential).",
          "Fill in billing details, payment terms, the **Customer price list** and whether a **Purchase order number required**.",
          "Select **Create customer**.",
        ],
      },
      {
        title: "Add a contact or job site",
        steps: [
          "Open the customer.",
          "Under **Contacts**, select **Add contact**, fill in the form and select **Save contact**.",
          "Under **Delivery / job sites**, select **Add job site**, enter the address and **Directions / access notes**, and select **Save job site**.",
        ],
      },
      {
        title: "Mark a job site's directions as verified",
        steps: ["On the customer page, find the site under **Delivery / job sites**.", "Select **Mark verified** and confirm."],
      },
      {
        title: "Export the customer list",
        steps: ["Set the search and filters you want.", "Select **Export CSV**. The file uses the same filters as the list."],
      },
      {
        title: "Archive or reactivate a customer",
        steps: ["Open the customer.", "Select **Archive** (or **Reactivate**) and confirm. Archived customers keep their history."],
      },
    ],
    prerequisites: ["Viewing needs customer access; creating and editing need the permission to edit customers."],
    troubleshooting: [
      {
        problem: "Saving says “Possible duplicate: …”.",
        fix: "A customer with the same name, email or phone exists. Open the existing record, or tick **This is a different customer — create it anyway** and save again.",
      },
      {
        problem: "“Customer not found or you do not have permission to edit it.”",
        fix: "The customer may have been removed, or your role cannot edit customers. Ask someone with edit access.",
      },
      {
        problem: "**New quote** or **New order** is missing on a customer page.",
        fix: "The customer is archived, or your role cannot create quotes or orders. Reactivate the customer to create new quotes.",
      },
      {
        problem: "“Customer created, but the contact could not be saved. Add it on the customer page.”",
        fix: "The customer was saved. Open it and use **Add contact** under **Contacts**.",
      },
    ],
    next: ["customer-crm", "quotes"],
    related: ["customer-pipeline", "materials-pricing", "orders"],
    reviewed: REVIEWED,
  },
  {
    id: "customer-crm",
    title: "Customer account, history, opportunities and follow-ups",
    summary: "Track the relationship with a customer or prospect: account owner, activity, follow-ups and opportunities.",
    category: "customers",
    routes: ["/customers/*"],
    permissions: ["customers.view"],
    audience: "Sales, office staff and owners.",
    whatYouSee: [
      "**Account**: relationship (Prospect or Customer), account owner and tags, with **Edit account**.",
      "**History**: orders and quotes won, ordered and delivered in the last 12 months (order totals, not invoices).",
      "**Opportunities**: work you are trying to win, with stage, value, probability and next action.",
      "**Follow-ups**: tasks with a due date and the person assigned.",
      "**Activity**: calls, meetings, logged emails, notes and site visits.",
    ],
    tasks: [
      {
        title: "Log a call or visit",
        steps: [
          "Open the customer and go to **Activity**.",
          "Choose **What is it** (Call, Meeting, Email (logged), Note or Site visit), write a **Summary** and optionally pick **With** and **On**.",
          "Select **Log activity**.",
        ],
      },
      {
        title: "Add a follow-up",
        steps: [
          "Under **Follow-ups**, enter what needs to be done, the **Due** date and **Assigned to**.",
          "Select **Add follow-up**. Mark it **Done** or **Cancel** it later.",
        ],
      },
      {
        title: "Add an opportunity",
        steps: [
          "Under **Opportunities**, open **New opportunity**.",
          "Enter a title, **Stage**, optional **Value ($)**, **Probability (%)**, **Expected close**, **Next action** and **Follow up on**.",
          "Select **Add opportunity**.",
        ],
      },
      {
        title: "Change the relationship or account owner",
        steps: ["Under **Account**, open **Edit account**.", "Change **Relationship**, **Account owner** or **Tags**.", "Select **Save account**."],
      },
    ],
    prerequisites: ["Changing account details, activity, follow-ups and opportunities needs the permission to edit customers."],
    troubleshooting: [
      { problem: "“Write a short summary.”", fix: "Activity needs a summary. Add a few words describing the contact." },
      { problem: "“Enter the value in dollars, e.g. 12500.”", fix: "Type the value as a number without letters, or leave it empty if unknown." },
      { problem: "“Enter a probability from 0 to 100, or leave it empty.”", fix: "Use a whole number between 0 and 100." },
      { problem: "“Say why it was lost — it helps the next quote.”", fix: "When the stage is Lost, fill in **If lost, why** before saving." },
      { problem: "“CRM needs a database update”.", fix: "Activities, follow-ups and opportunities appear once the database update is installed by the owner. Customers and quotes work as before." },
    ],
    next: ["customer-pipeline", "quotes"],
    related: ["customers"],
    reviewed: REVIEWED,
    limitations: ["Opportunity values are your own estimates; nothing here is invoiced.", "Logging an email records it only; Taviron does not send it."],
  },
  {
    id: "customer-pipeline",
    title: "Sales pipeline",
    summary: "See open opportunities by stage and the follow-ups due this week across all customers.",
    category: "customers",
    routes: ["/customers/pipeline"],
    permissions: ["customers.view"],
    audience: "Sales, office staff and owners.",
    whatYouSee: [
      "A summary of open opportunities, open value, value weighted by probability, and the number of prospects.",
      "One column per open stage: New lead, Contacted, Qualified, Quoting and Negotiation, each with its count and value.",
      "**Due this week**: open follow-ups and opportunity follow-up dates up to one week ahead, overdue first.",
    ],
    tasks: [
      {
        title: "Open the pipeline",
        steps: ["Go to **Customers**.", "Select **Pipeline**."],
      },
      {
        title: "Work an opportunity",
        steps: [
          "Select the opportunity's title. Its customer page opens at **Opportunities**.",
          "Update the stage, next action or follow-up date and save.",
        ],
      },
      {
        title: "See all prospects",
        steps: ["Select the prospects count in the summary. The customer list opens filtered to prospects."],
      },
    ],
    prerequisites: [],
    troubleshooting: [
      { problem: "“No open opportunities”.", fix: "Add one from a customer or prospect page (Opportunities → New opportunity)." },
      { problem: "“The pipeline needs a database update”.", fix: "The owner needs to install the CRM database update. Customers and quotes work as before." },
      { problem: "The **Pipeline** button is missing on Customers.", fix: "It appears only once the CRM database update is installed." },
    ],
    next: ["customer-crm"],
    related: ["customers", "quotes"],
    reviewed: REVIEWED,
    limitations: ["Values are the estimates people entered; nothing here is invoiced."],
  },
  {
    id: "materials-pricing",
    title: "Materials & Pricing",
    summary: "Maintain the materials, hauling charges, units and price lists used to build quotes.",
    category: "customers",
    routes: ["/materials", "/materials/*"],
    permissions: ["materials.view"],
    audience: "Owners and office staff who set prices.",
    whatYouSee: [
      "Tabs for **Materials**, **Hauling & charges**, **Price lists** and **Units**.",
      "Materials and charges with their code, default unit, taxable setting and status.",
      "Price lists with which customers use them; the **Standard** list applies to every customer whose own list has no rate for an item.",
      "Each rate's effective dates and a rate history (**Show rate history**).",
    ],
    tasks: [
      {
        title: "Add a material",
        steps: [
          "On the **Materials** tab, select **Add material**.",
          "Enter **Name**, **Code / SKU**, **Default unit** and whether it is **Taxable by default**.",
          "Select **Save material**.",
        ],
      },
      {
        title: "Add a rate to a price list",
        steps: [
          "On **Price lists**, open the list.",
          "Select **Add rate**, choose the **Material or charge**, enter the **Rate ($ per unit)** and **Effective from**.",
          "Select **Save rate**.",
        ],
      },
      {
        title: "Change a rate from a future date",
        steps: [
          "On the price list, select **Change rate** on the current rate.",
          "Enter the **New rate ($ per unit)** and when the **New rate starts**.",
          "Save. Existing quotes keep the rate they were saved with.",
        ],
      },
      {
        title: "Create a customer price list",
        steps: ["On **Price lists**, select **New price list**.", "Enter a name and select **Create price list**.", "Choose it as the **Customer price list** on the customer's record."],
      },
    ],
    prerequisites: ["Editing materials, charges and units needs the permission to edit materials. Price lists need the permission to edit pricing."],
    troubleshooting: [
      {
        problem: "“This item already has a rate starting on that date in this list. Edit that rate or pick another start date.”",
        fix: "Each item can have only one rate starting on a given date in a list. Correct the existing rate or choose another date.",
      },
      { problem: "“The new rate must start after the current rate's start date.”", fix: "Choose a start date later than the current rate's." },
      { problem: "“The standard price list cannot be deactivated.”", fix: "The standard list is the fallback for every customer. Change its rates instead." },
      { problem: "A quote did not change after you changed a rate.", fix: "This is intended: changing a rate never changes a saved quote. Revise the quote to use the new rate." },
    ],
    next: ["quotes"],
    related: ["customers", "orders"],
    reviewed: REVIEWED,
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Quotes and orders
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "quotes",
    title: "Quotes",
    summary: "Build a quote from your catalog and rates, save it as a draft and review it before sending.",
    category: "quotes-orders",
    routes: ["/quotes", "/quotes/new", "/quotes/*"],
    permissions: ["quotes.view"],
    audience: "Office staff, sales and owners.",
    whatYouSee: [
      "A list of every quote with its current revision, status and totals, filterable by **Status**.",
      "A **New quote** button (with the permission to edit quotes).",
      "The quote editor: **Customer and job**, **Line items**, **Instructions and terms** and **Totals**, with a sticky bar showing unsaved changes and the total.",
      "Rates are filled in from the customer's price list or standard rates. A line using another rate shows as an override.",
    ],
    tasks: [
      {
        title: "Create a quote",
        steps: [
          "Select **New quote**.",
          "Choose the customer (or create one with **Create and select**), the contact and the job site.",
          "Under **Line items**, select **Add material**, **Add hauling / charge** or add a **Custom line**, and enter quantities.",
          "Select **Save draft** to keep working, or **Save & review** to open the saved quote.",
        ],
      },
      {
        title: "Edit a draft",
        steps: ["Open the quote.", "Select **Edit draft**, make changes and save."],
      },
      {
        title: "Print or download a quote",
        steps: ["Open the quote.", "Select **Preview / print** to see the document, or **PDF** to download it."],
      },
    ],
    prerequisites: ["Creating and editing quotes needs the permission to edit quotes. Overriding a configured rate or giving a discount needs the pricing override permission."],
    troubleshooting: [
      {
        problem: "“Owner approval needed” appears in the editor.",
        fix: "A line uses a rate different from the configured price, or has a discount, and your role cannot override pricing. Use the configured rates or ask an owner.",
      },
      { problem: "“Choose a customer before saving.”", fix: "Pick a customer first; the right rates are filled in only after that." },
      { problem: "“Add at least one line item.”", fix: "Add a material, a hauling charge or a custom line." },
      {
        problem: "“Customer … is archived. Reactivate the customer before quoting.”",
        fix: "Open the customer and select **Reactivate**, then create the quote.",
      },
      {
        problem: "“This quote was changed by someone else while you were editing. Reload to see the latest version.”",
        fix: "Reload the page, check the other person's changes, then make yours again.",
      },
    ],
    next: ["quote-detail"],
    related: ["materials-pricing", "customers", "orders"],
    reviewed: REVIEWED,
  },
  {
    id: "quote-detail",
    title: "Send, revise and convert a quote",
    summary: "Email or mark a quote as sent, record the customer's answer, revise it, and convert an accepted quote to an order.",
    category: "quotes-orders",
    routes: ["/quotes/*"],
    permissions: ["quotes.view"],
    audience: "Office staff, sales and owners.",
    whatYouSee: [
      "Statuses: Draft, Sent, Accepted, Declined, Expired and Canceled.",
      "Buttons that depend on the status and your role: **Edit draft**, **Email quote** (or **Email again**), **Mark as sent**, **Preview / print**, **PDF**, **Revise**, **Mark accepted**, **Mark declined**, **Mark expired**, **Cancel quote** and **Convert to order**.",
      "**Revisions**: every revision is kept; sent revisions are never changed.",
      "**Emails and deliveries**: every send attempt, including failures and previews.",
      "**History** of status changes.",
    ],
    tasks: [
      {
        title: "Email a quote",
        steps: [
          "Open the quote and select **Email quote**.",
          "Check **To**, **Cc**, **Subject** and **Message**. A PDF of the quote is attached.",
          "Select **Send email**. If email is not set up, you see a preview instead and nothing is sent.",
        ],
      },
      {
        title: "Record that you sent it another way",
        steps: [
          "Select **Mark as sent**.",
          "Describe how it was delivered (for example “Printed and handed to customer at the yard”).",
          "Confirm with **Mark as sent**.",
        ],
      },
      {
        title: "Revise a sent quote",
        steps: ["Select **Revise**.", "Enter the **Reason for the revision**.", "Select **Create revision**, then edit the new draft revision."],
      },
      {
        title: "Turn an accepted quote into an order",
        steps: [
          "When the customer accepts, select **Mark accepted**.",
          "Select **Convert to order** and confirm with **Create order**.",
          "The order keeps the quote's accepted prices; open it from the **Order …** button.",
        ],
      },
    ],
    prerequisites: [
      "Sending needs the permission to send quotes; status changes need the quote status permission; converting needs the permission to edit orders.",
    ],
    troubleshooting: [
      {
        problem: "The email dialog says “Email is not configured” or “Preview only — nothing was sent”.",
        fix: "No email provider is set up for your company, so Taviron shows exactly what would be sent. If you emailed the quote yourself, close the dialog and use **Mark as sent**.",
      },
      { problem: "“Test mode” appears in the email dialog.", fix: "The email goes to a test inbox, not the customer, and the quote is not marked sent." },
      {
        problem: "“The quote PDF could not be generated, so nothing was sent. The draft is still editable. Try again.”",
        fix: "Try again in a moment. Nothing was sent to the customer.",
      },
      {
        problem: "“The email was not sent: … The quote was not marked as sent.”",
        fix: "The email provider refused the message. Check the addresses and try again, or send it yourself and use **Mark as sent**.",
      },
      { problem: "“Enter a reason for the revision.”", fix: "Revisions need a reason so the history explains the change." },
      { problem: "Status buttons are gone after converting.", fix: "A converted quote's status is fixed. Use the order from now on." },
    ],
    next: ["order-detail"],
    related: ["quotes", "settings-email"],
    reviewed: REVIEWED,
    limitations: [
      "Quote emails are sent only when the owner has set up an email provider. In demo companies, emails are always shown as a preview and never sent.",
    ],
  },
  {
    id: "orders",
    title: "Orders",
    summary: "Track work the customer has committed to, from accepted quotes or entered directly.",
    category: "quotes-orders",
    routes: ["/orders", "/orders/new"],
    permissions: ["orders.view"],
    audience: "Office staff, dispatchers and owners.",
    whatYouSee: [
      "A list of orders with **Quick filters**: Open, Scheduled today, Not scheduled, Drafts and On hold, plus a **Status** filter.",
      "Each order's source (From quote or Direct order), customer, schedule and status.",
      "A **New order** button for direct orders (with the permission to edit orders).",
    ],
    tasks: [
      {
        title: "Create a direct order",
        steps: [
          "Select **New order**.",
          "Choose the customer, contact and job site, and add materials and charges.",
          "Select **Save draft** or **Save & review**. The order number is assigned when you first save.",
          "On the order page, select **Confirm order** when it is ready.",
        ],
      },
      {
        title: "Create an order from a quote",
        steps: ["Open the accepted quote.", "Select **Convert to order** and confirm with **Create order**."],
      },
      {
        title: "Find orders waiting for a date",
        steps: ["On **Orders**, select the **Not scheduled** quick filter."],
      },
    ],
    prerequisites: ["Creating orders needs the permission to edit orders."],
    troubleshooting: [
      {
        problem: "“Customer … is archived. Reactivate the customer before creating an order.”",
        fix: "Reactivate the customer on its page, then create the order.",
      },
      {
        problem: "“Order … was created from a quote. Its prices and lines cannot be changed.”",
        fix: "Prices are as accepted on the quote. Revise the quote if the customer agreed to different prices.",
      },
      { problem: "“Owner approval needed” appears in the editor.", fix: "A rate differs from the configured price or a line has a discount, and your role cannot override pricing. Ask an owner." },
    ],
    next: ["order-detail"],
    related: ["quotes", "dispatch-board", "order-to-cash"],
    reviewed: REVIEWED,
  },
  {
    id: "order-detail",
    title: "Working an order: status, schedule and urgency",
    summary: "Confirm, schedule and move an order through delivery, and flag it as urgent when needed.",
    category: "quotes-orders",
    routes: ["/orders/*"],
    permissions: ["orders.view"],
    audience: "Office staff, dispatchers and owners.",
    whatYouSee: [
      "**Progress** across dispatch, delivery tickets and billing readiness, with the next step for each.",
      "**Customer and job**, **Delivery and schedule**, **Materials and charges** and **Loads and assignments**.",
      "Status buttons that match the current status, such as **Confirm order**, **Mark scheduled**, **Mark dispatched**, **Start work**, **Mark completed**, **Put on hold**, **Release hold** and **Cancel order**.",
      "**Set schedule** (or **Change schedule**), **Edit details** and **Flag as urgent**.",
      "**Dispatch base** when the company has more than one base.",
      "**History** of status changes and edits, newest first.",
    ],
    tasks: [
      {
        title: "Schedule an order",
        steps: [
          "Select **Set schedule**.",
          "Enter the **Delivery date**, **Through (multi-day)** if needed, the time window and **Scheduling notes**.",
          "Select **Save schedule**, then **Mark scheduled**.",
        ],
      },
      {
        title: "Flag an order as urgent",
        steps: [
          "Select **Flag as urgent**.",
          "Enter **Why is it urgent?** and, if there is one, the **Needed by (date)**.",
          "Confirm. Dispatch sees the reason and deadline; the schedule, trucks and customer are not changed.",
        ],
      },
      {
        title: "Plan loads for the order",
        steps: ["In **Loads and assignments**, select **Build loads** or **Open dispatch board**."],
      },
      {
        title: "Change the dispatch base",
        steps: ["Under **Delivery and schedule**, change **Dispatch base** and save."],
      },
    ],
    prerequisites: ["Scheduling needs the scheduling permission; status changes and details need the permission to edit orders; urgency actions need dispatch or order edit access."],
    troubleshooting: [
      {
        problem: "“Add the delivery location to order … before scheduling it: a job-site address, or a site name such as “Customer pickup at the yard”.”",
        fix: "Select **Edit details** and add a job site address or site name, then schedule again.",
      },
      { problem: "“The scheduled date cannot be in the past.”", fix: "Choose today or a later date." },
      { problem: "“Set a scheduled date before marking the order …”", fix: "Use **Set schedule** first." },
      {
        problem: "“This order was changed by someone else. Reload to see the latest version.”",
        fix: "Reload the page and make your change again.",
      },
      { problem: "“Base not changed”.", fix: "The message explains why, for example the base is not active or you can only work with orders at your own bases." },
    ],
    next: ["load-build", "dispatch-board"],
    related: ["orders", "billing", "order-to-cash"],
    reviewed: REVIEWED,
    limitations: ["Completed and canceled orders are final and can no longer be edited. History is kept."],
  },
  {
    id: "load-build",
    title: "Build loads for an order",
    summary: "Split what is left of an order into planned loads that your in-service trucks can carry.",
    category: "dispatch",
    routes: ["/orders/*"],
    permissions: ["dispatch.edit"],
    audience: "Dispatchers.",
    whatYouSee: [
      "**What is left to plan**: ordered, planned and remaining quantity.",
      "**Draft settings**: **Quantity per load**, **Loads per day**, **Spread** (Evenly across the scheduled days, or As early as possible), and **Start time** / **End time** when the order has no daily time window.",
      "**Draft loads**: the proposed loads by date and quantity, with **Check before approving** notes.",
    ],
    tasks: [
      {
        title: "Build and approve loads",
        steps: [
          "On the order, select **Build loads** in **Loads and assignments**.",
          "Enter the **Quantity per load** and **Loads per day**, choose the **Spread**, and select **Show draft**.",
          "Review the draft, then select **Approve and add … planned loads**.",
          "Assign trucks and drivers on the dispatch board.",
        ],
      },
      {
        title: "Change the draft",
        steps: ["Change the settings and select **Show draft** again. Nothing is added until you approve."],
      },
    ],
    prerequisites: ["Needs the permission to edit dispatch. The order must be scheduled (or further along) with scheduled dates from today on."],
    troubleshooting: [
      { problem: "“The order has no scheduled dates from today on. Schedule the order first.”", fix: "Open the order, select **Set schedule** or **Change schedule**, and come back." },
      { problem: "“Nothing left to plan: the planned loads already cover the ordered quantity.”", fix: "All the quantity is already planned. Use the dispatch board to change existing loads." },
      { problem: "“No active, in-service truck without an open safety report.”", fix: "Return a truck to service or resolve its open report in Maintenance or Driver Reports." },
      {
        problem: "“The order has more than one material or hauling line. Building loads per line is not supported yet; plan these loads on the dispatch board.”",
        fix: "Add the loads on the dispatch board with **Add load**.",
      },
      {
        problem: "“The order, its loads or the fleet changed since you reviewed this draft. Review the new draft and approve again.”",
        fix: "Look at the new draft and approve again.",
      },
    ],
    next: ["dispatch-board"],
    related: ["order-detail", "smart-dispatch"],
    reviewed: REVIEWED,
    limitations: ["Trip times are not calculated yet, so loads per day comes from you.", "No truck or driver is assigned when you approve; loads can be changed or canceled on the dispatch board."],
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "dispatch-board",
    title: "Dispatch board",
    summary: "Plan loads for scheduled orders and assign a truck, trailer and driver to each.",
    category: "dispatch",
    routes: ["/dispatch", "/dispatch/resources"],
    permissions: ["dispatch.view"],
    audience: "Dispatchers and owners.",
    whatYouSee: [
      "The day you are planning, with **Previous day**, **Next day** and **Go to date**.",
      "**Urgent orders** and **Needs scheduling** (confirmed orders without a delivery date) at the top.",
      "**Smart Dispatch** proposals for loads without a truck.",
      "Each scheduled order with its loads, and **Trucks today** and **Drivers today** with their bookings and eligibility.",
      "**Plan the day** and **Driver & truck availability** buttons.",
    ],
    tasks: [
      {
        title: "Add a load",
        steps: [
          "Find the order on the board and select **Add load**.",
          "Enter **Start** and **End** times, the **Planned quantity** and **Unit**, and **Notes for the driver**.",
          "Select **Save load**. Start and end times prevent double-booking trucks, trailers and drivers.",
        ],
      },
      {
        title: "Assign a truck and driver",
        steps: [
          "On the load, select **Assign**.",
          "Choose the **Truck**, **Trailer** and **Driver**. The board says whether the combination can be assigned and why not.",
          "Confirm. To change it later, select **Reassign** or **Remove assignment**.",
        ],
      },
      {
        title: "Give an order a delivery date from the board",
        steps: ["Under **Needs scheduling**, select **Schedule** on the order.", "Choose the date and confirm. It then appears on the board for that day."],
      },
      {
        title: "Check who is available",
        steps: [
          "Select **Driver & truck availability**.",
          "Review **Trucks** (mechanically ready, in the shop) and **Drivers** (qualified, on leave, booked) for the day.",
        ],
      },
    ],
    prerequisites: ["Viewing needs dispatch access. Adding and assigning loads needs the permission to edit dispatch; scheduling orders needs the scheduling permission."],
    troubleshooting: [
      {
        problem: "“Order … is …. Mark it scheduled before assigning trucks.”",
        fix: "Open the order and select **Mark scheduled**, then assign.",
      },
      {
        problem: "“… was just assigned to another load at this time by someone else. Reload the board.”",
        fix: "Someone else booked that truck, trailer or driver. Reload and choose another.",
      },
      {
        problem: "The combination cannot be assigned: for example “No CDL is recorded for this driver.” or “Driver has approved time off on this date.”",
        fix: "Fix the record (add the driver's qualification in Fleet, or choose another driver), or pick another combination.",
      },
      {
        problem: "“Truck has an open safety-critical work order. It returns to service only after an authorized inspection clears it.”",
        fix: "Choose another truck, or have the inspection recorded in Maintenance → Clearance queue.",
      },
      { problem: "“A tractor needs a trailer for this load.”", fix: "Choose a trailer, or use a dump truck." },
      { problem: "“On hold — loads cannot be assigned until the hold is released.”", fix: "Release the hold on the order first." },
    ],
    next: ["smart-dispatch", "route-planner"],
    related: ["plan-the-day", "load-build", "fleet-drivers"],
    reviewed: REVIEWED,
    limitations: ["Hours of service are not checked by Taviron. Confirm them yourself before assigning.", "Driver time off is not shown on availability until the time-off database update is installed."],
  },
  {
    id: "smart-dispatch",
    title: "Smart Dispatch proposals",
    summary: "Review proposed truck and driver pairs for unassigned loads and approve or reject each one.",
    category: "dispatch",
    routes: ["/dispatch"],
    permissions: ["dispatch.view"],
    audience: "Dispatchers.",
    whatYouSee: [
      "**Smart Dispatch** on the dispatch board, covering a period you choose (today, 3 days or 7 days ahead).",
      "Each unassigned load with a **Proposed:** truck and driver, the reasons, and **Why trucks and drivers were ruled out**.",
      "**About these proposals** and the limits of what was checked.",
      "Proposals never change anything on their own; each one waits for your decision.",
    ],
    tasks: [
      {
        title: "Approve a proposal",
        steps: [
          "Read the proposal and its reasons.",
          "Select **Approve and assign**.",
          "In **Confirm hours of service**, check the driver's hours yourself and select **I checked — assign**.",
        ],
      },
      {
        title: "Reject a proposal",
        steps: [
          "Select **Reject…**, add a **Reason for rejecting** if you like, and confirm.",
          "The next option is proposed. Use **Reconsider** to bring rejected options back.",
        ],
      },
    ],
    prerequisites: ["Approving needs the permission to edit dispatch; everyone with dispatch access can see proposals."],
    troubleshooting: [
      {
        problem: "“This proposal is no longer valid — … The proposals have been refreshed; review them again.”",
        fix: "The board changed after the proposal was made. Review the refreshed proposals.",
      },
      {
        problem: "“Smart Dispatch suggestions are unavailable right now. The board below still works; try again in a moment.”",
        fix: "Assign loads on the board yourself, or reload later.",
      },
      { problem: "“No feasible truck and driver.”", fix: "No combination passes every rule. Check **Why trucks and drivers were ruled out** and fix the record that blocks it." },
      {
        problem: "Trucks from another base are never proposed.",
        fix: "Cross-Base Dispatch is off. An administrator can turn it on in Settings → Dispatch Bases.",
      },
    ],
    next: ["plan-the-day"],
    related: ["dispatch-board", "settings-dispatch-bases"],
    reviewed: REVIEWED,
    limitations: ["Hours of service are not checked; you confirm them before each approval."],
  },
  {
    id: "plan-the-day",
    title: "Plan the day",
    summary: "Plan every unassigned load for a day at once, ranked by the priorities you choose, and approve the assignments you want.",
    category: "dispatch",
    routes: ["/dispatch/plan"],
    permissions: ["dispatch.view"],
    audience: "Dispatchers and owners.",
    whatYouSee: [
      "A **Day** from today to 14 days ahead and a **Planning mode**: Balanced, Service first, Revenue first or Efficiency first.",
      "**Adjust priorities** (collapsed; 0 = ignore, 5 = most important) for service reliability, revenue (estimate), truck utilization, fewer empty trips, driver workload balance and keeping crews together.",
      "**Plans** with four measures (loads covered, estimated revenue, trucks and drivers used, assignments that need review), **More plan details** (urgent and overdue coverage, average truck fill, site changes, workload), and how other presets compare.",
      "Each proposed assignment with a checkbox, a status (**Recommended**, **Needs review** or **Blocked**), what to check, and **View explanation** for the full reasons.",
      "**Missing or estimated information** that limits the plan, and **Unavailable resources** with the reason for each truck, trailer or driver.",
    ],
    tasks: [
      {
        title: "Build a plan",
        steps: [
          "On **Dispatch**, select **Plan the day**.",
          "Choose the **Day** and a **Planning mode**, or select **Show plan** to keep the current one.",
          "To fine-tune, open **Adjust priorities**, move the sliders and select **Plan with these priorities**.",
        ],
      },
      {
        title: "Approve assignments from a plan",
        steps: [
          "Tick the assignments you want.",
          "Select **Approve … selected**.",
          "In **Confirm hours of service**, check hours yourself and select **I checked — approve**.",
        ],
      },
    ],
    prerequisites: ["Approving needs the permission to edit dispatch; without it the page is view only."],
    troubleshooting: [
      {
        problem: "“The plan could not be built right now. Nothing was changed; try again in a moment, or use the Dispatch board.”",
        fix: "Try again later, or assign on the dispatch board.",
      },
      { problem: "“Some assignments were not made.”", fix: "Something changed since the plan was built. Show the plan again and review what is left." },
      { problem: "The day you chose was replaced by another.", fix: "Plans cover today through 14 days ahead; a day outside that range is replaced by tomorrow." },
      { problem: "The day has no loads.", fix: "The page lists other days in the next two weeks with loads waiting for a truck and driver." },
    ],
    next: ["dispatch-board"],
    related: ["smart-dispatch", "company-setup"],
    reviewed: REVIEWED,
    limitations: [
      "Priorities only rank options that pass every safety, legal, qualification, capacity and maintenance rule.",
      "Margin is not evaluated without cost data, and revenue is an estimate.",
      "**Explain this plan** gives an AI-generated summary only when an administrator has turned that feature on; it never changes the plan.",
    ],
  },
  {
    id: "route-planner",
    title: "Routes on Dispatch",
    summary: "See each truck's day as a route, and an order's suggested route beside the board.",
    category: "dispatch",
    routes: ["/dispatch"],
    permissions: ["dispatch.view"],
    audience: "Dispatchers.",
    whatYouSee: [
      "On **Dispatch**, select **Route** on an order: a panel beside the board shows the trip from the yard to the site and back, and the day of each truck already carrying the order.",
      "The **Routes** view: a **Day** (30 days back to 30 days ahead) and a **Truck** filter, with **Show routes**.",
      "One card per truck with its trailer, driver, number of loads, and stops in load order.",
      "Distances by road with driving times when truck routing is set up, otherwise straight-line distances marked as estimates.",
      "Sites without a location and, if not set, the **Yard location**.",
    ],
    tasks: [
      {
        title: "View routes for a day",
        steps: ["On **Dispatch**, open the **Routes** view.", "Choose the **Day** and, optionally, one **Truck**.", "Select **Show routes**."],
      },
      {
        title: "Add a site's location",
        steps: [
          "Under the sites without a location, enter the **Latitude, longitude** (copy them from any map).",
          "Select **Save**. Legs to that site then get a distance.",
        ],
      },
      {
        title: "Set the yard location",
        steps: ["Under **Yard location**, enter the **Yard coordinates**.", "Select **Save yard**. Routes then start and end at the yard."],
      },
    ],
    prerequisites: ["Adding site locations needs the permission to edit customers; setting the yard needs the permission to manage settings."],
    troubleshooting: [
      { problem: "“No assigned loads on this day”.", fix: "Routes appear once loads are assigned to trucks on the dispatch board." },
      { problem: "“Distance unknown: a location is missing”.", fix: "Add the missing site location on this page." },
      {
        problem: "“Truck routing is not set up yet (the owner adds a HERE key). Distances below are straight lines.”",
        fix: "Straight lines are the shortest possible distance; trucks drive further. The owner can set up truck routing.",
      },
      { problem: "“Truck routing is off in demo companies. Distances below are straight lines.”", fix: "This is expected in a demo." },
    ],
    next: ["dispatch-board"],
    related: ["customers", "my-day"],
    reviewed: REVIEWED,
    limitations: [
      "Routes are read from the dispatch board; they change only when the board does.",
      "Road routing uses a standard truck profile because truck dimensions are not recorded yet. A route without notices is not a guarantee the road is clear.",
      "The yard location needs a database update; until it is installed, routes begin at the first delivery.",
    ],
  },
  {
    id: "driver-reports",
    title: "Driver Reports",
    summary: "See and act on delays, breakdowns and equipment or inspection problems sent by drivers.",
    category: "dispatch",
    routes: ["/field-reports", "/field-reports/*"],
    permissions: ["field_reports.view"],
    audience: "Dispatchers, shop staff and office staff.",
    whatYouSee: [
      "Tabs for **Open**, **Acknowledged**, **Resolved** and **All** reports.",
      "Report kinds: Running late, Can't complete the load, Breakdown, Equipment problem and Inspection problem.",
      "On a report: **What the driver reported** and **Act on it**, with links to the load, the order and the truck or trailer record.",
    ],
    tasks: [
      {
        title: "Acknowledge a report",
        steps: ["Open the report.", "Select **Acknowledge**, add a **Note (optional)**, and confirm. The driver sees that the office has seen it."],
      },
      {
        title: "Resolve a report",
        steps: ["Open the report.", "Select **Resolve**, describe **How was it resolved?**, and confirm."],
      },
      {
        title: "Send an equipment problem to the shop",
        steps: ["Open the report.", "Select **Create a work order**. The work order opens with the report linked."],
      },
    ],
    prerequisites: ["Acknowledging and resolving need the permission to manage driver reports. Delay reports are shown only to people with dispatch access."],
    troubleshooting: [
      { problem: "“Enter how it was resolved.”", fix: "Write a short note before resolving." },
      {
        problem: "The truck is still shown as in service after a breakdown report.",
        fix: "Reports never change equipment status or loads by themselves. Take the truck out of service on its Fleet page if needed.",
      },
      { problem: "**Create a work order** is missing.", fix: "It needs the permission to manage maintenance." },
    ],
    next: ["maintenance-work-orders"],
    related: ["my-day", "command-center", "fleet-trucks"],
    reviewed: REVIEWED,
  },
  {
    id: "my-day",
    title: "My Day for drivers",
    summary: "See your loads, enter delivery tickets and report problems from your phone.",
    category: "dispatch",
    routes: ["/driver", "/driver/*"],
    permissions: ["driver.portal"],
    audience: "Drivers.",
    whatYouSee: [
      "**Today** and **Tomorrow**: each load's times, order and load number, job, site directions, site contact and load notes.",
      "**Updates from dispatch** about new or changed assignments, and shop appointments for your truck.",
      "**Tickets still needed**, **My recent tickets** and **My reports**, with reminders about your CDL and medical card.",
      "On a phone, tabs at the bottom: **My Day**, **Messages** (if your role has messaging), **Time off** and **Profile**.",
      "A reminder to use Taviron only when parked.",
    ],
    tasks: [
      {
        title: "Enter a delivery ticket",
        steps: [
          "On the load, select **Enter delivery ticket** (from the day of the load).",
          "Enter **What did you deliver?**, the **Quantity on the ticket**, the **Unit**, the **Paper / scale ticket number** and the **Delivery time**.",
          "Optionally **Take a photo** of the paper ticket.",
          "Select **Send ticket**. The office reviews every ticket.",
        ],
      },
      {
        title: "Report a problem",
        steps: [
          "On the load, select **Report a problem**.",
          "Choose **What is happening?** and, for equipment, **Which equipment?**.",
          "Describe **What happened?** and select **Send report**. In an emergency, call 911 and dispatch first.",
        ],
      },
      {
        title: "Request time off",
        steps: ["Select **Request time off** (or the **Time off** tab).", "Fill in the request and select **Send request**."],
      },
    ],
    prerequisites: ["Your sign-in must be linked to your driver record by the office (Fleet → Drivers)."],
    troubleshooting: [
      {
        problem: "“Your account is not linked to a driver yet”.",
        fix: "Ask the office to link your login to your driver record (Fleet → Drivers). Until then no loads can be shown.",
      },
      {
        problem: "“Not sent — no connection to the office. Nothing was saved on this phone.”",
        fix: "Check your signal and tap **Send again**, or call dispatch.",
      },
      { problem: "“Ticket entry opens on the day of the load.”", fix: "Wait until the delivery day to enter the ticket." },
      { problem: "“This may be out of date.”", fix: "Select **Refresh** or reopen the page when you have signal." },
      {
        problem: "You reported a breakdown but your loads did not change.",
        fix: "A report is a message to the office. It does not take the truck out of service or change your loads; dispatch decides.",
      },
    ],
    next: ["time-off"],
    related: ["driver-reports", "delivery-tickets", "communications"],
    reviewed: REVIEWED,
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Fleet
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "fleet-overview",
    title: "Fleet overview",
    summary: "See at a glance which trucks, trailers and drivers are ready for work, and what needs attention.",
    category: "fleet",
    routes: ["/fleet"],
    permissions: ["fleet.view"],
    audience: "Owners, dispatchers, shop and office staff.",
    whatYouSee: [
      "Counts for trucks and trailers in service, drivers eligible today, out of service, safety restricted, preventive overdue, shop visits in the next 7 days and documents expiring.",
      "**Out of service**: active equipment that cannot be assigned until it is returned to service.",
      "**Drivers needing attention**: qualifications expired or expiring within 30 days.",
      "**Vehicle documents needing renewal**: expired or due within 30 days.",
      "**Check a combination**: whether a truck, trailer and driver can be assigned together on a date, and why not.",
      "Tabs for **Overview**, **Trucks**, **Trailers** and **Drivers**.",
    ],
    tasks: [
      {
        title: "Find what needs attention",
        steps: ["Open **Fleet**.", "Check **Out of service**, **Drivers needing attention** and **Vehicle documents needing renewal**.", "Select a record to fix it."],
      },
      {
        title: "Check whether a truck, trailer and driver can work together",
        steps: ["Under **Check a combination**, choose the truck, trailer and driver.", "Read the result: eligible, or the reasons it cannot be assigned."],
      },
      {
        title: "Add equipment or a driver",
        steps: ["Open the **Trucks**, **Trailers** or **Drivers** tab.", "Select **Add truck**, **Add trailer** or **Add driver**."],
      },
    ],
    prerequisites: ["Adding and editing needs the permission to edit fleet records."],
    troubleshooting: [
      {
        problem: "You expected a renewal reminder email.",
        fix: "No reminders are sent; the lists on this page are the reminder.",
      },
      { problem: "“Nothing in the fleet yet”.", fix: "Add your first truck, trailer or driver from this page." },
    ],
    next: ["fleet-trucks", "fleet-drivers"],
    related: ["fleet-documents", "maintenance-overview"],
    reviewed: REVIEWED,
  },
  {
    id: "fleet-trucks",
    title: "Trucks",
    summary: "Add trucks, record their capacity, assign a usual driver and take them in and out of service.",
    category: "fleet",
    routes: ["/fleet/trucks", "/fleet/trucks/new", "/fleet/trucks/*"],
    permissions: ["fleet.view"],
    audience: "Owners, fleet managers and dispatchers.",
    whatYouSee: [
      "A searchable list of trucks with type, status and driver.",
      "On a truck: availability, capacity and its verification, compatibility, documents, assignment history and maintenance history.",
      "**Assign a driver** (or **Reassign**), **Take out of service** / **Return to service**, **Edit** and **Deactivate**.",
      "Maintenance costs and cost per mile for people with maintenance cost access.",
    ],
    tasks: [
      {
        title: "Add a truck",
        steps: [
          "On **Trucks**, select **Add truck**.",
          "Enter the **Unit number** as painted on the truck and choose its **Type**.",
          "Add **Weight capacity (payload)** and **Body volume (cubic yards)** when you know them; tick **I have verified these capacities** only after checking them.",
          "Select **Add truck**.",
        ],
      },
      {
        title: "Take a truck out of service",
        steps: [
          "Open the truck and select **Take out of service**.",
          "Enter the **Reason** and an **Expected back (optional)** date.",
          "Confirm. It is not eligible for assignments until it is returned to service.",
        ],
      },
      {
        title: "Assign the truck's usual driver",
        steps: ["Open the truck and select **Assign a driver**.", "Choose the driver and select **Assign**."],
      },
    ],
    prerequisites: ["Adding and editing need the permission to edit fleet records; changing service status needs the fleet service permission; assigning a driver needs the fleet assignment permission."],
    troubleshooting: [
      {
        problem: "“Truck … has an open safety-critical work order (…). It returns to service only after an authorized inspection clears it in Maintenance.”",
        fix: "An authorized person records the inspection in Maintenance → Clearance queue; that returns the truck to service.",
      },
      { problem: "“Enter a reason for taking the equipment out of service.”", fix: "Add a short reason before confirming." },
      { problem: "“The expected return date cannot be in the past.”", fix: "Choose today or a later date, or leave it empty." },
      { problem: "Dispatch warns “Truck capacity is recorded but not verified.”", fix: "Check the capacity, then edit the truck and tick **I have verified these capacities**." },
    ],
    next: ["fleet-documents", "dispatch-board"],
    related: ["fleet-trailers", "maintenance-work-orders"],
    reviewed: REVIEWED,
  },
  {
    id: "fleet-trailers",
    title: "Trailers",
    summary: "Add trailers, record capacity and which truck types they fit, and manage their service status.",
    category: "fleet",
    routes: ["/fleet/trailers", "/fleet/trailers/new", "/fleet/trailers/*"],
    permissions: ["fleet.view"],
    audience: "Owners, fleet managers and dispatchers.",
    whatYouSee: [
      "A list of trailers with type and status.",
      "On a trailer: capacity, **Compatible truck types**, **Usually paired with truck**, documents and maintenance history.",
      "**Take out of service** / **Return to service**, **Edit** and **Deactivate**.",
    ],
    tasks: [
      {
        title: "Add a trailer",
        steps: [
          "On **Trailers**, select **Add trailer**.",
          "Enter the **Unit number**, **Type**, capacity and compatible truck types.",
          "Select **Add trailer**.",
        ],
      },
      {
        title: "Retire a trailer",
        steps: ["Open the trailer and select **Deactivate**.", "Confirm. It is hidden from lists and never eligible for assignments; its history is kept."],
      },
    ],
    prerequisites: ["Adding and editing need the permission to edit fleet records."],
    troubleshooting: [
      { problem: "Dispatch says “This trailer is not recorded as compatible with this truck type.”", fix: "Edit the trailer and add the truck type under **Compatible truck types**, or choose another trailer." },
      { problem: "Dispatch says “Trailer capacity is not recorded.”", fix: "Edit the trailer and enter its capacity." },
      { problem: "“Trailer not found or you do not have permission to edit it.”", fix: "Ask someone with fleet edit access." },
    ],
    next: ["fleet-documents"],
    related: ["fleet-trucks", "dispatch-board"],
    reviewed: REVIEWED,
  },
  {
    id: "fleet-drivers",
    title: "Drivers and qualifications",
    summary: "Add drivers, link them to their sign-in, and record the CDL and medical card that dispatch checks.",
    category: "fleet",
    routes: ["/fleet/drivers", "/fleet/drivers/new", "/fleet/drivers/*"],
    permissions: ["fleet.view"],
    audience: "Owners, office staff and dispatchers.",
    whatYouSee: [
      "A list of drivers showing qualifications and whether they have a login.",
      "On a driver: **Licenses and qualifications** (CDL, DOT medical card, Hazmat endorsement, TWIC card, Other), whether each is verified, and expiry dates.",
      "**Linked user account**, so the driver sees their loads on My Day.",
      "**Mark inactive** / **Reactivate** for drivers who leave or return.",
    ],
    tasks: [
      {
        title: "Add a driver",
        steps: [
          "On **Drivers**, select **Add driver**.",
          "Choose the **Linked user account** if they sign in (or enter the name), and add **Phone**, **Employee number** and **Hire date**.",
          "Select **Add driver**.",
        ],
      },
      {
        title: "Record a CDL or medical card",
        steps: [
          "Open the driver and select **Add qualification**.",
          "Choose the **Type**, then enter **Class**, **Issuing state**, **Issued** and **Expires** as they appear on the document.",
          "Tick **I have seen the original document and the details above match it** to save it as verified.",
          "Save.",
        ],
      },
    ],
    prerequisites: ["Adding and editing drivers needs the permission to edit fleet records."],
    troubleshooting: [
      { problem: "Dispatch says “No CDL is recorded for this driver.” or “No DOT medical card is recorded for this driver.”", fix: "Add the qualification on the driver's page. Without both, the driver is not eligible for assignments." },
      { problem: "Dispatch says “Driver's CDL has not been verified.”", fix: "Check the original document, edit the qualification and tick the verification box." },
      { problem: "“This user is already linked to another driver.”", fix: "Unlink the login from the other driver record first." },
      { problem: "“The selected user is not a member of your company.”", fix: "Invite the person on People first, then link their login." },
    ],
    next: ["dispatch-board"],
    related: ["people", "my-day", "fleet-overview"],
    reviewed: REVIEWED,
    limitations: ["Leaving an expiry date blank means the qualification does not count as valid. Unknown is never treated as OK."],
  },
  {
    id: "fleet-documents",
    title: "Vehicle documents",
    summary: "Record registration, insurance, inspection certificates and permits for each truck and trailer, with expiry warnings.",
    category: "fleet",
    routes: ["/fleet/trucks/*", "/fleet/trailers/*"],
    permissions: ["fleet.view"],
    audience: "Owners and office staff.",
    whatYouSee: [
      "A documents section on each truck and trailer: Registration, Insurance, Inspection certificate, Permit, Lease agreement, Title / ownership and Other.",
      "Each document's number, issuer, dates and whether it is verified.",
      "**Ownership** (Owned, Financed, Leased or Rented).",
      "Fleet overview lists vehicles with an expired document or one due within 30 days.",
    ],
    tasks: [
      {
        title: "Add a document",
        steps: [
          "Open the truck or trailer and select **Add document**.",
          "Choose the **Document** kind and enter **Number**, **Issued by**, **Issued on** and **Expires on**.",
          "Select **Save document**.",
        ],
      },
      {
        title: "Mark a document as verified",
        steps: ["After checking the original, select **Mark verified** on the document."],
      },
      {
        title: "Replace an old document",
        steps: ["Add the renewed document.", "Select **Archive** on the old one. It stays in the history but no longer counts as current."],
      },
    ],
    prerequisites: ["Needs the permission to edit fleet records."],
    troubleshooting: [
      {
        problem: "Dispatch says a verified insurance or registration has expired.",
        fix: "Record the renewed document. Depending on your company's rule, an expired verified document blocks assignment or only warns (Settings → Dispatch rules).",
      },
      { problem: "“An archived document cannot be restored. Add a new one instead.”", fix: "Add the document again." },
      { problem: "“Document tracking is not available yet”.", fix: "The database update that adds it has not been installed, or your role cannot see it." },
    ],
    next: ["settings-dispatch-rules"],
    related: ["fleet-trucks", "fleet-trailers", "fleet-overview"],
    reviewed: REVIEWED,
    limitations: ["No reminder emails are sent; the Fleet overview list is the reminder."],
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "maintenance-overview",
    title: "Maintenance overview",
    summary: "See open shop work, equipment out of service, preventive services due and technician workload in one place.",
    category: "maintenance",
    routes: ["/maintenance"],
    permissions: ["maintenance.view"],
    audience: "Shop staff, mechanics, fleet managers and owners.",
    whatYouSee: [
      "Counts for open work orders, immediate / safety, awaiting clearance, out of service, overdue PM and due soon.",
      "**Suggested shop order**: open work ranked by fixed rules (safety, urgency, downtime, due dates and parts).",
      "**Out of service** with downtime and possible replacement trucks.",
      "**Scheduled in the next 7 days** and **Technician workload**.",
      "Tabs for **Overview**, **Work orders**, **Preventive** and **Clearance queue**.",
    ],
    tasks: [
      {
        title: "Decide what the shop works on next",
        steps: ["Open **Maintenance**.", "Start from the top of **Suggested shop order** and open each work order to update it."],
      },
      {
        title: "Start a new work order",
        steps: ["Select **New work order**."],
      },
    ],
    prerequisites: ["Creating and changing work orders needs the permission to manage maintenance."],
    troubleshooting: [
      { problem: "“No trucks or trailers”.", fix: "Add trucks or trailers in Fleet first; a work order belongs to one of them." },
      { problem: "The suggested order does not assign anyone.", fix: "It only suggests; nothing is assigned or scheduled automatically." },
    ],
    next: ["maintenance-work-orders", "maintenance-preventive"],
    related: ["maintenance-clearance", "fleet-overview"],
    reviewed: REVIEWED,
    limitations: ["The suggested shop order uses fixed rules; no AI service is connected."],
  },
  {
    id: "maintenance-work-orders",
    title: "Work orders",
    summary: "Record shop work on a truck or trailer, track parts, labor and costs, and move it through to completion.",
    category: "maintenance",
    routes: ["/maintenance/work-orders", "/maintenance/work-orders/new", "/maintenance/work-orders/*"],
    permissions: ["maintenance.view"],
    audience: "Mechanics, shop staff and fleet managers.",
    whatYouSee: [
      "A list of work orders with filters for **Status**, **Truck**, **Category**, **Urgency** and **Mechanic**.",
      "On a work order: **The job**, **Findings and labor**, **Parts, labor and costs** (with cost access), **Linked** records and **History**.",
      "Status buttons such as **Mark triaged**, **Mark scheduled**, **Start work**, **Waiting for parts**, **Send for inspection**, **Mark completed**, **Close** and **Cancel work order**.",
      "Drivers of the truck see scheduled shop appointments on My Day.",
    ],
    tasks: [
      {
        title: "Create a work order",
        steps: [
          "Select **New work order**.",
          "Choose the **Truck** or **Trailer**, enter a **Title**, **Category**, **Urgency** and **Description**.",
          "Tick **Safety-critical defect (brakes, steering, tires, lights, load securement…)** when it applies.",
          "Select **Create work order**.",
        ],
      },
      {
        title: "Add a part or labor cost",
        steps: ["Open the work order.", "Enter **Kind**, **Description**, **Quantity** and **Unit cost ($)**.", "Select **Add cost**."],
      },
      {
        title: "Finish a safety-critical repair",
        steps: [
          "When the repair is done, select **Send for inspection**.",
          "An authorized person records the result in the **Clearance queue**.",
        ],
      },
      {
        title: "Cancel a work order",
        steps: ["Select **Cancel work order**, enter the **Reason**, and confirm."],
      },
    ],
    prerequisites: ["Creating and changing work orders needs the permission to manage maintenance; costs need the maintenance cost permission."],
    troubleshooting: [
      { problem: "“Safety-critical repairs cannot be completed directly. Send the work order for inspection.”", fix: "Select **Send for inspection** instead of **Mark completed**." },
      { problem: "“Set a scheduled date first.”", fix: "Enter **Scheduled for** before marking it scheduled." },
      { problem: "“Only someone who can clear vehicles for service may cancel a safety-critical work order.”", fix: "Ask someone with the clearance permission." },
      { problem: "“This work order is … and can no longer be edited.”", fix: "Completed, closed and canceled work orders are final. Reopen it if your role allows, or create a new one." },
      { problem: "“This work order was changed by someone else. Reload to see the latest version.”", fix: "Reload the page and make your change again." },
    ],
    next: ["maintenance-clearance"],
    related: ["maintenance-overview", "driver-reports", "fleet-trucks"],
    reviewed: REVIEWED,
  },
  {
    id: "maintenance-preventive",
    title: "Preventive maintenance",
    summary: "Set service schedules by days, miles or engine hours, record readings and create work orders for services that are due.",
    category: "maintenance",
    routes: ["/maintenance/preventive"],
    permissions: ["maintenance.view"],
    audience: "Shop staff and fleet managers.",
    whatYouSee: [
      "Schedules per truck or trailer with **Next due**, by calendar days, miles and/or engine hours, whichever comes first.",
      "**Preventive maintenance data**: missing or old readings, never assumed.",
      "**Record a reading** for odometer and engine hours.",
      "**Add a schedule** form.",
    ],
    tasks: [
      {
        title: "Add a schedule",
        steps: [
          "Under **Add a schedule**, choose the equipment and enter the **Service** (for example “Oil and filter”).",
          "Enter at least one interval: **Every … days**, **Every … miles** or **Every … engine hours**, plus when it was last done.",
          "Select **Add schedule**.",
        ],
      },
      {
        title: "Record a reading",
        steps: ["Under **Record a reading**, choose the truck and enter **Odometer (mi)** and/or **Engine hours**.", "Select **Record reading**."],
      },
      {
        title: "Create work orders for due services",
        steps: ["Select **Create work orders for due services**. A service never gets two work orders."],
      },
    ],
    prerequisites: ["Needs the permission to manage maintenance."],
    troubleshooting: [
      { problem: "“The odometer cannot go down: the last reading was … miles.”", fix: "Check the reading. A value lower than the last one is refused." },
      { problem: "“Enter the odometer, the engine hours, or both.”", fix: "Fill in at least one reading." },
      { problem: "“Enter a name for the service, for example “Oil and filter”.”", fix: "Name the service before saving." },
      { problem: "A schedule shows “not enough data”.", fix: "Enter when it was last done and record a current reading." },
    ],
    next: ["maintenance-work-orders"],
    related: ["maintenance-overview"],
    reviewed: REVIEWED,
  },
  {
    id: "maintenance-clearance",
    title: "Clearance queue",
    summary: "Record the inspection that returns a vehicle to service after a safety-critical repair.",
    category: "maintenance",
    routes: ["/maintenance/clearance"],
    permissions: ["maintenance.view"],
    audience: "People authorized to clear vehicles for service.",
    whatYouSee: [
      "Work orders waiting for an authorized inspection.",
      "**Start inspection**, then **Passed — clear for service** or **Failed**.",
      "Only people allowed to clear vehicles for service can record the inspection.",
    ],
    tasks: [
      {
        title: "Clear a vehicle for service",
        steps: [
          "Open **Clearance queue** and select **Start inspection** on the work order.",
          "Select **Passed — clear for service**, add **Inspection notes (optional)**, and confirm with **Clear for service**.",
        ],
      },
      {
        title: "Record a failed inspection",
        steps: ["Select **Failed**.", "Describe **What failed** so the shop knows what to fix.", "Confirm with **Record failure**."],
      },
    ],
    prerequisites: ["Recording inspections needs the clearance permission."],
    troubleshooting: [
      { problem: "“Describe what failed so the shop knows what to fix.”", fix: "A failed inspection needs a description." },
      { problem: "“This work order is not waiting for inspection.”", fix: "The shop must select **Send for inspection** on the work order first." },
    ],
    next: ["dispatch-board"],
    related: ["maintenance-work-orders", "fleet-trucks"],
    reviewed: REVIEWED,
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Delivery tickets and billing
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "delivery-tickets",
    title: "Delivery tickets",
    summary: "Enter what was actually delivered from paper or scale tickets, separate from the dispatch plan and from billing.",
    category: "tickets-billing",
    routes: ["/tickets", "/tickets/new", "/tickets/*"],
    permissions: ["tickets.view"],
    audience: "Office staff, dispatchers and owners.",
    whatYouSee: [
      "Tabs: **Loads awaiting a ticket**, **Needs review**, **Submitted**, **Accepted**, **Voided** and **All tickets**.",
      "Search by ticket number, paper ticket number, order, customer, truck or driver, and filters for **Review reason** and **Photo or scan**.",
      "On a ticket: delivery details, **Delivery context** (planned against delivered), paper ticket photos, review flags and **History** of revisions.",
    ],
    tasks: [
      {
        title: "Enter a ticket for a load",
        steps: [
          "On **Loads awaiting a ticket**, select **Enter ticket** for the load.",
          "Choose the **Order line** and enter the **Delivered quantity**, **Unit**, **Paper / scale ticket #**, **Delivery date** and **Delivery time**.",
          "Check the **Truck**, **Trailer** and **Driver** (filled in from the dispatch assignment).",
          "Select **Submit ticket**.",
        ],
      },
      {
        title: "Attach a scan or photo of the paper ticket",
        steps: ["Open the ticket.", "Under **Paper ticket photos**, choose a JPEG, PNG or WebP scan or photo."],
      },
      {
        title: "Correct a ticket",
        steps: ["Open the ticket and select **Correct**.", "Change the figures and enter the **Reason for the correction**.", "Select **Save correction**. Every revision is kept."],
      },
    ],
    prerequisites: ["Entering and correcting tickets needs the permission to edit tickets."],
    troubleshooting: [
      {
        problem: "“… load … already has ticket …. Confirm that this is a separate delivery to add another.”",
        fix: "If it really is another delivery, tick **Yes, this is a separate delivery — record it (it will be flagged for review)**.",
      },
      { problem: "“You can enter the ticket from the day of the load.”", fix: "Wait until the load's delivery day." },
      { problem: "“Load … is canceled. Tickets can only be entered for planned loads.”", fix: "Check the load on the dispatch board." },
      { problem: "“Ticket … was accepted. Only a reviewer can correct it.”", fix: "Ask an office reviewer to correct it." },
      { problem: "“A ticket can have at most 6 images.”", fix: "Images cannot be removed once added, so attach only the clearest scans or photos." },
      { problem: "“Delivery tickets cannot be deleted. Void them instead.”", fix: "Ask a reviewer to select **Void**." },
    ],
    next: ["ticket-review"],
    related: ["my-day", "billing", "dispatch-board"],
    reviewed: REVIEWED,
  },
  {
    id: "ticket-review",
    title: "Reviewing delivery tickets",
    summary: "Accept tickets that match their paper record, check flagged ones, and void mistakes.",
    category: "tickets-billing",
    routes: ["/tickets", "/tickets/*"],
    permissions: ["tickets.view"],
    audience: "Office reviewers.",
    whatYouSee: [
      "The **Needs review** tab with each ticket's review reasons, why they matter and what has to happen next.",
      "Review reasons such as unit differs from the order line, delivered on a different day, truck/trailer/driver differs from the assignment, no paper ticket number, another ticket for the load, and a duplicate paper ticket number.",
      "**Accept** (or **Accept and next** in the queue), **Correct**, **Flag for review** and **Void**.",
      "**Accept clean tickets (…)** on lists with tickets received without any review reason.",
      "Keyboard shortcuts in the review queue: J next, K previous, A accept.",
    ],
    tasks: [
      {
        title: "Review flagged tickets one by one",
        steps: [
          "Open **Needs review** and select the first ticket.",
          "Compare it with the paper ticket and read the review reasons.",
          "Select **Correct** if something was typed wrong, or **Accept and next** if it is right.",
        ],
      },
      {
        title: "Accept clean tickets together",
        steps: ["Open **Submitted**.", "Select **Accept clean tickets (…)** and confirm. Tickets with any review reason are reviewed one by one."],
      },
      {
        title: "Void a ticket",
        steps: ["Open the ticket and select **Void**.", "Enter the **Reason** and confirm with **Void ticket**."],
      },
    ],
    prerequisites: ["Accepting, flagging and voiding need the ticket review permission."],
    troubleshooting: [
      { problem: "“Enter the reason for the correction.”", fix: "Corrections need a reason so the history explains them." },
      {
        problem: "“Ticket … revision … is …. Only the current revision of a live ticket can be corrected.”",
        fix: "Open the current revision of the ticket and correct that.",
      },
      {
        problem: "A ticket in another unit than the order line.",
        fix: "No conversion is made. Correct the unit or quantity if it was typed wrong; otherwise accept it and billing shows a difference to acknowledge.",
      },
    ],
    next: ["billing"],
    related: ["delivery-tickets", "payroll"],
    reviewed: REVIEWED,
    limitations: ["Accepting confirms the ticket matches the paper record. It does not bill the customer or change the order."],
  },
  {
    id: "billing",
    title: "Billing Readiness",
    summary: "See which delivered work is documented, reviewed and ready to invoice, and hand orders off to your accounting system.",
    category: "tickets-billing",
    routes: ["/billing", "/billing/*"],
    permissions: ["billing.view"],
    audience: "Office and billing staff, owners.",
    whatYouSee: [
      "Views: **All orders**, **Missing tickets**, **Tickets to review**, **Exceptions**, **Ready to bill** and **Handed off**.",
      "Each order's status: Missing documentation, Tickets need review, Blocked — exceptions, Work not completed, Ready to bill or Handed off.",
      "On an order: **Order lines** (ordered against delivered), **Loads**, exceptions, an **Invoice draft** preview and **Billing history**.",
      "Handoff batches with **Download file (CSV)**.",
    ],
    tasks: [
      {
        title: "Acknowledge billing exceptions",
        steps: [
          "Open the order from **Exceptions**.",
          "Review the differences (for example delivered differs from ordered, or customer PO missing).",
          "Select **Acknowledge**, enter the **Reason** and confirm. Tickets and prices are not changed.",
        ],
      },
      {
        title: "Hand off orders for billing",
        steps: [
          "Open **Ready to bill** and tick the orders.",
          "Select **Hand off selected**, add a **Reference (optional)** and **Notes (optional)**.",
          "Confirm with **Create batch**, then **Download file (CSV)** and enter the invoices in your accounting system.",
        ],
      },
      {
        title: "Undo a handoff",
        steps: ["Open **Handed off**.", "Select **Undo handoff** on the order, enter the reason and confirm."],
      },
    ],
    prerequisites: ["Acknowledging, handing off and undoing need the permission to manage billing."],
    troubleshooting: [
      { problem: "An order is not in **Ready to bill**.", fix: "An order is ready when it is completed, every load has an accepted ticket and every exception is acknowledged. The order's row says what still blocks it." },
      { problem: "“Enter the reason for accepting these exceptions.”", fix: "Write why the order can be billed as it stands." },
      { problem: "“Tickets changed after the handoff — check the invoice in your accounting system.”", fix: "A ticket was corrected after handoff. Compare it with the invoice you entered." },
      { problem: "“No longer current — exceptions changed”.", fix: "The tickets changed after the acknowledgment. Review and acknowledge again." },
    ],
    next: ["order-to-cash"],
    related: ["ticket-review", "order-detail", "reports"],
    reviewed: REVIEWED,
    limitations: [
      "Billing Readiness is a checklist. It does not create invoices, change prices or mark anything paid; invoices are entered in your accounting system.",
      "The invoice draft is a computed preview from accepted tickets and the order's prices; nothing is issued, sent or exported to accounting.",
    ],
  },
  {
    id: "order-to-cash",
    title: "Order to cash",
    summary: "Follow every open order from confirmation to billing handoff and see which team acts next.",
    category: "tickets-billing",
    routes: ["/order-to-cash"],
    permissions: ["billing.view"],
    audience: "Owners and office staff.",
    whatYouSee: [
      "Stage counts: Needs scheduling, Needs loads, In delivery, Tickets, Billing review, Ready to bill and Handed off, with how many need attention and their value.",
      "A list of orders that need someone to act, oldest first within each stage, with the reason and the team that acts next.",
      "Filters for **Stage** and **Show** (Needs attention or Everything), and a search.",
    ],
    tasks: [
      {
        title: "Find stuck orders",
        steps: ["Open **Order to Cash**.", "Keep **Show** on **Needs attention**.", "Open an order to act on it in its own module."],
      },
      {
        title: "See every order in one stage",
        steps: ["Select a stage card at the top."],
      },
    ],
    prerequisites: [],
    troubleshooting: [
      { problem: "“Nothing needs attention”.", fix: "Every open order is moving on its own. Choose **Everything** under **Show** to see where each one is." },
      { problem: "An order's stage is wrong.", fix: "This page reads the same records as Orders, Dispatch, Tickets and Billing. Fix the record there; nothing here changes an order." },
    ],
    next: ["billing"],
    related: ["orders", "command-center"],
    reviewed: REVIEWED,
    limitations: ["Invoices and payments are coming soon: issuing invoices, tracking what customers owe and recording payments are not built yet, so this view ends at Handed off."],
  },
  {
    id: "payroll",
    title: "Payroll",
    summary: "Calculate drivers' gross earnings from verified delivery tickets using your company's own pay rules.",
    category: "people",
    routes: ["/payroll", "/payroll/*"],
    permissions: ["payroll.manage"],
    audience: "Owners (payroll access is the owner's by default).",
    whatYouSee: [
      "**Payroll periods** with status, number of drivers and gross earnings.",
      "**Calculation is off** until a pay rule is active and calculation is turned on.",
      "**Settings**: **Calculate earnings from verified tickets**, **Pay period** and when a period starts.",
      "**Pay rules**: your rule written as a formula, with **Preview on recent verified tickets**.",
      "On a period: ticket earnings, exceptions, **Adjustments**, **Approve and lock**, and CSV downloads.",
    ],
    tasks: [
      {
        title: "Set up a pay rule",
        steps: [
          "Select **Pay rules**.",
          "Write your company's agreed rule as a **Formula** (for example tons × rate per ton) and select **Save draft**.",
          "Check the preview on recent verified tickets.",
          "Confirm the rule matches your agreed pay terms and select **Approve and activate**.",
        ],
      },
      {
        title: "Turn calculation on",
        steps: ["On **Payroll**, tick **Calculate earnings from verified tickets**.", "Choose the **Pay period** and select **Save settings**."],
      },
      {
        title: "Run a payroll period",
        steps: [
          "Under **New period**, enter the **First day** and **Last day** and select **Create period**.",
          "Open the period and select **Calculate … tickets**.",
          "Resolve exceptions, add adjustments if needed, and select **Approve and lock**.",
          "Use **Download summary (CSV)** or **Download ticket detail (CSV)** for your payroll provider.",
        ],
      },
    ],
    prerequisites: ["Needs the payroll permission. Who can see payroll is set on People → Sign-ins & roles."],
    troubleshooting: [
      { problem: "“Tick the box to confirm this rule matches your agreed pay terms.”", fix: "Confirm the rule before activating it." },
      { problem: "“Tick the box to confirm the totals before approving.”", fix: "Check the totals and tick the box." },
      { problem: "A ticket is listed as “Not verified yet (waiting for office review)”.", fix: "Only tickets accepted by the office are payable. Ask a reviewer to accept it." },
      { problem: "“Payroll needs a database update”.", fix: "The owner must install the payroll database update. Delivery tickets keep working as before." },
    ],
    next: ["ticket-review"],
    related: ["people", "delivery-tickets"],
    reviewed: REVIEWED,
    limitations: [
      "Taviron has no built-in pay rule: nothing is calculated until your company writes, approves and activates its own rule and turns calculation on.",
      "Gross earnings only: no taxes, withholding or payments. Adjustments are entered by a person; nothing is deducted automatically.",
      "An approved period is locked; later changes go into a later period.",
    ],
  },

  // ---------------------------------------------------------------------------------------------------------------
  // People and time off
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "people",
    title: "People",
    summary: "Keep a directory of everyone who works for the company, their work schedule, and who can sign in.",
    category: "people",
    routes: ["/employees", "/employees/new", "/employees/*"],
    permissions: ["employees.view"],
    audience: "Owners and office staff.",
    whatYouSee: [
      "**Directory**: everyone with job title, department, contact and status, with filters and search.",
      "**Sign-ins & roles** (for people who manage users): every sign-in and its role.",
      "On a person: employment details, **Work schedule**, **Taviron sign-in**, and for drivers their qualifications and primary truck.",
      "**Pay (confidential)** only for people with the confidential pay permission.",
    ],
    tasks: [
      {
        title: "Add a person",
        steps: [
          "Select **Add person**.",
          "Enter **Full name**, **Job title**, **Department**, **Work email** and **Hire date**.",
          "To give them a sign-in, tick **Send them a Taviron sign-in** and choose a **Role**.",
          "Save.",
        ],
      },
      {
        title: "Send a sign-in to an existing person",
        steps: ["Open the person.", "Under **Taviron sign-in**, choose the role and select **Send a sign-in**."],
      },
      {
        title: "Change someone's role",
        steps: ["Open **Sign-ins & roles**.", "Select **Change role or access** on the person, choose the **Role**, and save."],
      },
      {
        title: "Record a work schedule",
        steps: ["Open the person.", "Enter hours per weekday under **Work schedule**.", "Select **Save schedule**."],
      },
    ],
    prerequisites: ["Adding and editing needs the permission to edit people; sign-ins and roles need the permission to manage users."],
    troubleshooting: [
      { problem: "“Add a work email to this person first (Edit), then send the sign-in.”", fix: "Select **Edit**, add the work email, then send the sign-in." },
      { problem: "“Only an owner can add another owner.”", fix: "Ask an owner to give the Owner role." },
      { problem: "“Invitations are turned off in the demo company: it never sends email to anyone.”", fix: "This is expected in a demo." },
      {
        problem: "“Person added. No sign-in was sent: …”",
        fix: "The record was saved but the invitation could not be sent; the message says why. Sending sign-ins needs invitations to be set up on the server.",
      },
      { problem: "“That login is already linked to another employee. Unlink it there first.”", fix: "Open the other person and select **Unlink login**." },
      { problem: "“Work schedules need a database update that has not been installed yet.”", fix: "Ask the owner to install the update. Everything else works." },
    ],
    next: ["settings-roles-permissions", "time-off"],
    related: ["fleet-drivers", "payroll"],
    reviewed: REVIEWED,
    limitations: ["A job title describes the job only. What a person can do in Taviron comes from their role."],
  },
  {
    id: "time-off",
    title: "Time off",
    summary: "Request time off, follow your requests, and approve or deny requests from others.",
    category: "people",
    routes: ["/time-off", "/time-off/*"],
    permissions: [],
    audience: "Everyone; approvers decide requests.",
    whatYouSee: [
      "**My balances** (when balances are set up): available hours, which is the balance minus your pending requests.",
      "**Request time off** (or **Request or enter time off** for approvers) and **My requests**.",
      "**Everyone's requests** for people who can see or approve requests.",
      "Statuses: Pending, Approved, Denied and Canceled.",
    ],
    tasks: [
      {
        title: "Request time off",
        steps: [
          "Choose the **Category** (Vacation, Sick, Personal, Bereavement, Jury duty, Unpaid leave or Other).",
          "Choose **Full day(s)** with **First day** and **Last day**, or **Part of a day** with **From** and **To**.",
          "Add a **Comment (optional)**; it is never shown to dispatch.",
          "Select **Send request**.",
        ],
      },
      {
        title: "Approve or deny a request",
        steps: ["Under **Everyone's requests**, open the request.", "Select **Approve** or **Deny**, add a comment if needed, and confirm. The employee sees the decision and your note."],
      },
      {
        title: "Cancel your request",
        steps: ["Open your request.", "Select **Cancel request** and confirm. The dates become free again."],
      },
    ],
    prerequisites: ["Approving needs the time-off approval permission; entering time off for others is for approvers."],
    troubleshooting: [
      { problem: "“You cannot decide your own time-off request. Another approver must decide it.”", fix: "Ask another approver." },
      { problem: "“This overlaps another request (…). Cancel or change that one first.”", fix: "Cancel the earlier request, then send a new one." },
      {
        problem: "“This request uses … h of …, but only … h are available (balance … h, other pending requests … h).”",
        fix: "Ask for fewer hours or choose another category; an administrator can adjust the balance.",
      },
      { problem: "“Approved time off that has started can only be canceled by an approver.”", fix: "Ask an approver to cancel it." },
      { problem: "“This request waits for step … (…): someone with the … role decides it.”", fix: "Your company uses an approval chain. Someone with that role decides this step." },
      { problem: "“Time-off requests need a database update that has not been installed yet.”", fix: "Ask the owner to install the update." },
    ],
    next: ["time-off-balances"],
    related: ["settings-time-off-approval", "dispatch-board", "people"],
    reviewed: REVIEWED,
    limitations: ["Approved leave makes a driver unavailable to dispatch for those dates and hours; loads already booked are not canceled automatically."],
  },
  {
    id: "time-off-balances",
    title: "Time-off banks and balances",
    summary: "Set up the banks time off draws from, accrual policies, and grant or adjust hours.",
    category: "people",
    routes: ["/time-off/balances"],
    permissions: ["time_off.balances"],
    audience: "Owners and office staff who manage time off.",
    whatYouSee: [
      "**Banks and balances**: each bank with the current employees who can use it and their available hours.",
      "**Accrual policies** per bank and employment type.",
      "**Grant hours**, **Adjust balance** and **Record hours worked**.",
      "The balance history: every grant, adjustment, use and return, never edited or deleted.",
    ],
    tasks: [
      {
        title: "Create a bank",
        steps: [
          "Under **New bank**, enter the **Bank name** (for example Paid time off).",
          "Choose the kinds of time off that draw from it and who can use it.",
          "Select **Create bank**.",
        ],
      },
      {
        title: "Grant or adjust hours",
        steps: ["Choose the **Employee** and **Bank**.", "Choose **Grant (adds hours)** or **Adjustment (+ or −)**, enter **Hours** and, for adjustments, a **Reason**.", "Save."],
      },
      {
        title: "Post accruals",
        steps: ["Save an accrual policy for the bank.", "Select **Run accruals through today**. Nothing runs on its own."],
      },
    ],
    prerequisites: ["Needs the time-off balances permission."],
    troubleshooting: [
      { problem: "“Say why the balance is adjusted.”", fix: "Adjustments need a reason; the employee sees it." },
      { problem: "“This would take the balance below zero (balance … h).”", fix: "A balance never goes below zero. Use a smaller adjustment." },
      { problem: "“A kind of time off can draw from one bank only; … already covers one of these.”", fix: "Remove that kind from the other bank first." },
      { problem: "“Nothing new to post — accruals are up to date.”", fix: "No hours were due since the last run." },
    ],
    next: ["time-off"],
    related: ["settings-time-off-approval", "people"],
    reviewed: REVIEWED,
    limitations: ["Time-off balances need a database update; until it is installed, requests are not checked against a balance."],
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Communications
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "communications",
    title: "Communications",
    summary: "Messages, groups, channels, operational workspaces, alerts and announcements inside Taviron.",
    category: "communications",
    routes: ["/communications", "/communications/*"],
    permissions: [],
    audience: "Everyone; what you can send depends on your role.",
    whatYouSee: [
      "Tabs: **Messages**, **Channels**, **Alerts**, **Announcements** and **Settings**.",
      "**Conversations** filtered by All, Direct, Groups and Workspaces, with unread counts.",
      "**Notifications**, **Search** and **People** with each coworker's status.",
      "**My status** (Automatic, Available, Busy or Away), **New message**, **New group** and **New workspace** (depending on your role).",
      "Alerts addressed to you that need acknowledgment, and company announcements.",
    ],
    tasks: [
      {
        title: "Send a direct message",
        steps: ["Select **New message**.", "Choose the person and select **Open conversation**.", "Write a message and press Enter or select **Send**."],
      },
      {
        title: "Start a group",
        steps: ["Select **New group**.", "Choose the members and, optionally, a **Group name (optional)**.", "Select **Create group**."],
      },
      {
        title: "Acknowledge an alert",
        steps: ["Open **Alerts** and the alert.", "Select **Acknowledge** and confirm."],
      },
      {
        title: "Publish an announcement",
        steps: ["Open **Announcements** and select **New announcement**.", "Enter the **Title**, **Audience** and text.", "Select **Publish**."],
      },
    ],
    prerequisites: [
      "Messaging needs the messaging permission. Groups, channels, workspaces, alerts, announcements and administration each have their own permission.",
    ],
    troubleshooting: [
      {
        problem: "“Messaging is not part of your role”.",
        fix: "Ask your administrator if you need to send messages. You can still read announcements and alerts addressed to you.",
      },
      { problem: "“You cannot post in this conversation.”", fix: "You may no longer be a member, or the conversation is closed or archived." },
      { problem: "“Upload failed. Check your connection.”", fix: "Attachments can be photos or PDFs up to 10 MB. Check your signal and try again." },
      { problem: "Communications shows “Not available yet”.", fix: "Communications needs a database update that has not been installed yet." },
    ],
    next: ["settings-audit-log"],
    related: ["my-day", "people"],
    reviewed: REVIEWED,
    limitations: ["Everything stays inside Taviron: nothing is sent by email or text message."],
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "reports",
    title: "Reports",
    summary: "Deliveries, verified delivered value, billing turnaround, truck utilization and figures by dispatch base for a period.",
    category: "reports",
    routes: ["/reports"],
    permissions: ["tickets.view", "billing.view", "fleet.view", "dispatch.view"],
    audience: "Owners and managers.",
    whatYouSee: [
      "A period: **Last 7 days**, **Last 30 days**, **Last 90 days**, or your own **From** and **To**.",
      "**Deliveries and rework**: tickets, corrected and voided tickets, and time from delivery to accepted.",
      "**Verified delivered value** by customer, material / line and truck: accepted ticket quantities × the order's approved rate, before percentage charges, discounts and tax. Not invoiced amounts.",
      "**Billing turnaround** and **Truck utilization and downtime**.",
      "**By Dispatch Base** when the company has more than one base: trucks, drivers, orders, loads and ordered value per base.",
      "Sections depend on your role.",
    ],
    tasks: [
      {
        title: "Change the period",
        steps: ["Select **Last 7 days**, **Last 30 days** or **Last 90 days**, or enter **From** and **To** and select **Show**."],
      },
      {
        title: "Compare dispatch bases",
        steps: ["Scroll to **By Dispatch Base**. Every record belongs to one base, so nothing is counted twice."],
      },
    ],
    prerequisites: ["Each section needs the matching access: tickets, billing, fleet or dispatch."],
    troubleshooting: [
      { problem: "“The report could not be produced”.", fix: "Try again in a moment, or choose a shorter period." },
      { problem: "**By Dispatch Base** is missing.", fix: "It appears only when the company has more than one dispatch base." },
      { problem: "“Accepted tickets not priced” is above zero.", fix: "Those order lines have no rate. Check the order's prices." },
    ],
    next: ["billing"],
    related: ["settings-dispatch-bases", "order-to-cash"],
    reviewed: REVIEWED,
    limitations: ["Profitability is not calculated: profit per load, truck, customer or material needs cost data Taviron does not have. No savings or return on investment are claimed."],
  },

  // ---------------------------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------------------------
  {
    id: "settings-company",
    title: "Settings: Company and branding",
    summary: "Your company details, quote defaults, ticket and urgency rules, and your logo and colors in the app.",
    category: "settings",
    routes: ["/settings"],
    permissions: [],
    audience: "Owners and administrators; everyone can view.",
    whatYouSee: [
      "**Company**: name, address, phone, email, website and **Business timezone** (decides what “today” means for loads, tickets and the Command Center).",
      "**Quote defaults**: **Default sales tax %**, **Quotes valid for (days)**, **Follow up after (days)**, **Default quote terms** and **Quote footer note**.",
      "**Delivery tickets** (require the paper or scale ticket number), **Urgent orders** (escalation time) and **Job site directions** (how often to review them).",
      "**Branding**: **Logo**, **Accent color** and **Navigation color**, with a preview.",
    ],
    tasks: [
      {
        title: "Change company details or defaults",
        steps: ["Open **Settings** → **Company and branding**.", "Change the fields.", "Select **Save settings**."],
      },
      {
        title: "Add your logo and colors",
        steps: [
          "Under **Branding**, choose a **Logo** (PNG, JPEG or WebP, at most 250 KB).",
          "Pick the **Accent color** and **Navigation color**; leave empty for the defaults.",
          "Select **Save branding**. Everyone in your company sees it on their next page.",
        ],
      },
    ],
    prerequisites: ["Changing settings and branding needs the permission to manage company settings."],
    troubleshooting: [
      { problem: "“Only an owner can change company settings.”", fix: "Ask an owner or administrator to make the change." },
      { problem: "“Use an image of at most 250 KB.”", fix: "Resize or compress the logo and try again." },
      { problem: "“The logo must be a PNG, JPEG or WebP image.”", fix: "Save the logo in one of these formats." },
      { problem: "A sent quote still shows the old address.", fix: "This is intended: already-sent quotes keep the details they were sent with." },
    ],
    next: ["settings-numbering"],
    related: ["company-setup", "settings-email"],
    reviewed: REVIEWED,
    limitations: ["Branding changes the app for your company only. Quotes and the public website are not changed."],
  },
  {
    id: "settings-numbering",
    title: "Settings: Numbering",
    summary: "Choose the prefix, year and digits used for quote, order and ticket numbers.",
    category: "settings",
    routes: ["/settings"],
    permissions: ["settings.manage"],
    audience: "Owners and administrators.",
    whatYouSee: [
      "**Document numbering**: each document with its **Next number** and **Format**.",
      "An **Edit** dialog with **Prefix**, **Include year**, **Digits** and **Next number**.",
      "Year-based numbers restart at 1 each January.",
    ],
    tasks: [
      {
        title: "Change a number format",
        steps: [
          "Open **Settings** → **Numbering**.",
          "Select **Edit** on the document.",
          "Change **Prefix**, **Include year**, **Digits** or **Next number**, check the preview, and select **Save**.",
        ],
      },
      {
        title: "Continue numbering from your old system",
        steps: ["Select **Edit** on the document.", "Set **Next number** to the number after your last one, and save."],
      },
    ],
    prerequisites: ["Needs the permission to manage company settings."],
    troubleshooting: [
      {
        problem: "Saving a document later fails because its number is taken.",
        fix: "Numbering saved never duplicates a number: if a number is already taken, saving that document is refused. Set **Next number** above the highest number in use.",
      },
      { problem: "“Unknown sequence.”", fix: "Reload the page and try again." },
    ],
    next: ["settings-email"],
    related: ["settings-company"],
    reviewed: REVIEWED,
  },
  {
    id: "settings-email",
    title: "Settings: Email",
    summary: "See whether quote emails are sent for real, sent to a test inbox, or shown as a preview only.",
    category: "settings",
    routes: ["/settings"],
    permissions: [],
    audience: "Owners and office staff.",
    whatYouSee: [
      "**Email delivery** with the current **Mode**: **Live**, **Test** or **Preview only**, and what it means.",
      "The sending address, when one is configured.",
      "When not live, what the owner needs to do on the server to send real emails.",
    ],
    tasks: [
      {
        title: "Check whether quote emails reach customers",
        steps: ["Open **Settings** → **Email**.", "Read the **Mode**. Only **Live** delivers to customers."],
      },
      {
        title: "Send quotes while email is not set up",
        steps: ["Print or download the quote from **Preview / print** or **PDF**.", "Send it yourself, then use **Mark as sent** on the quote."],
      },
    ],
    prerequisites: ["The email provider is set up by the owner on the server; it cannot be changed on this page."],
    troubleshooting: [
      { problem: "Mode is **Preview only**.", fix: "No email provider is configured. Quote emails are shown but never sent." },
      { problem: "Mode is **Test**.", fix: "Every email goes to the configured test inbox and quotes are not marked sent." },
    ],
    next: ["quote-detail"],
    related: ["settings-company"],
    reviewed: REVIEWED,
    limitations: ["This page describes how quote emails are handled. Communications never sends email or text messages. Demo companies never send email."],
  },
  {
    id: "settings-dispatch-rules",
    title: "Settings: Dispatch rules",
    summary: "Decide what an expired vehicle document does to dispatch: block the assignment or warn.",
    category: "settings",
    routes: ["/settings"],
    permissions: ["settings.manage", "dispatch.view"],
    audience: "Owners and administrators; dispatchers can view.",
    whatYouSee: [
      "**Expired vehicle documents**: one rule each for Registration, Insurance, Inspection and Permit.",
      "**Block assignment** or **Warn only** for each kind.",
      "Only a document someone marked verified in Fleet can block; an unverified one is a warning so a person confirms the renewal.",
    ],
    tasks: [
      {
        title: "Change a document rule",
        steps: [
          "Open **Settings** → **Dispatch rules**.",
          "For each kind, choose **Block assignment** or **Warn only**.",
          "Select **Save document rules**. Dispatch checks use them from now on.",
        ],
      },
      {
        title: "Check what a rule does on the board",
        steps: ["On **Dispatch**, select **Assign** on a load and choose the truck. A blocked or warned document is shown before you confirm."],
      },
    ],
    prerequisites: ["Changing rules needs the permission to manage company settings."],
    troubleshooting: [
      { problem: "“Choose block or warn for every document.”", fix: "Pick a rule for each kind before saving." },
      {
        problem: "“Document rules need a database update that has not been installed yet.”",
        fix: "Until the update is installed, expired documents are review notes only.",
      },
    ],
    next: ["fleet-documents"],
    related: ["dispatch-board"],
    reviewed: REVIEWED,
    limitations: ["Lease, title and other documents are not checked. Check the rules that apply where you operate."],
  },
  {
    id: "settings-dispatch-bases",
    title: "Settings: Dispatch Bases",
    summary: "Set up the yards or terminals you work from, choose who works where, and allow cross-base dispatch.",
    category: "settings",
    routes: ["/settings"],
    permissions: ["settings.manage", "users.manage", "dispatch.view"],
    audience: "Owners and administrators; dispatchers can view.",
    whatYouSee: [
      "**Dispatch Bases**: each base with location, time zone, trucks, drivers and status (Default, Active or Inactive).",
      "How many active bases your plan includes.",
      "**Add a Base**, **Edit**, **Make Default**, **Deactivate** and **Reactivate**.",
      "**Cross-Base Dispatch** (with more than one active base): whether Smart Dispatch may propose trucks and drivers from other bases.",
      "**Who Works Where** (for people who manage users): which bases each person can see and change.",
    ],
    tasks: [
      {
        title: "Add a base",
        steps: [
          "Open **Settings** → **Dispatch Bases**.",
          "Open **Add a Base** and enter **Name**, **Code** (short, e.g. NORTH), address, **Time zone** and contact.",
          "Select **Add Base**.",
        ],
      },
      {
        title: "Limit a person to some bases",
        steps: [
          "Under **Who Works Where**, find the person.",
          "Untick the bases they do not work with and select **Save**. They show as **Limited**.",
          "Owners always see every base.",
        ],
      },
      {
        title: "Allow cross-base dispatch",
        steps: ["Under **Cross-Base Dispatch**, tick **Allow trucks and drivers from other bases**.", "Select **Save**."],
      },
      {
        title: "Change the default base",
        steps: ["Select **Make Default** on the base. New trucks, drivers and orders without a base go there."],
      },
    ],
    prerequisites: ["Bases and cross-base dispatch need the permission to manage company settings; Who Works Where needs the permission to manage users."],
    troubleshooting: [
      {
        problem: "“Base limit reached” or “Your plan includes … dispatch base…. Deactivate one, or ask Taviron about a plan with more bases.”",
        fix: "Deactivate a base to add another, or ask Taviron about a plan with more bases.",
      },
      { problem: "“Another base already uses that code.”", fix: "Choose a different code." },
      { problem: "“The code is 1–10 letters, digits or dashes, e.g. NORTH or YARD-2.”", fix: "Shorten the code or remove other characters." },
      { problem: "“Make another base the default before deactivating this one.”", fix: "Select **Make Default** on another base first." },
      {
        problem: "A person says orders disappeared.",
        fix: "They may be limited to some bases under **Who Works Where**. They only see and change those bases' trucks, drivers and orders.",
      },
      { problem: "“Dispatch bases need a database update that has not been installed yet.”", fix: "Until then the company works as one base." },
    ],
    next: ["smart-dispatch"],
    related: ["reports", "order-detail", "people"],
    reviewed: REVIEWED,
    limitations: ["Deactivating a base keeps its trucks, drivers and orders unchanged."],
  },
  {
    id: "settings-time-off-approval",
    title: "Settings: Time off approval chain",
    summary: "Decide who approves time-off requests, in order.",
    category: "settings",
    routes: ["/settings"],
    permissions: ["settings.manage"],
    audience: "Owners and administrators.",
    whatYouSee: [
      "**Time-off approval chain**: up to five steps, each with a **Step name** and **Decided by** role.",
      "With no chain, one approval by anyone with the time-off approval permission decides.",
      "Only the last step approves and uses hours from the balance; a denial at any step ends the request.",
    ],
    tasks: [
      {
        title: "Set up an approval chain",
        steps: [
          "Open **Settings** → **Time off**.",
          "Select **Add a step**, enter a **Step name** and choose who it is **Decided by**. Repeat for each step.",
          "Select **Save approval chain**.",
        ],
      },
      {
        title: "Go back to a single approval",
        steps: ["Select **Remove** on every step.", "Select **Save approval chain**."],
      },
    ],
    prerequisites: ["Needs the permission to manage company settings. Each step is decided by someone in that role who also has the time-off approval permission."],
    troubleshooting: [
      { problem: "“An approval chain has at most five steps.”", fix: "Remove a step." },
      { problem: "“Give each step a short name (up to 60 characters).”", fix: "Shorten the step names." },
      { problem: "Pending requests went back to step 1.", fix: "This is intended: saving a new chain restarts pending requests at step 1." },
      { problem: "“Approval chains need a database update that has not been installed yet.”", fix: "Until then one approval decides each request." },
    ],
    next: ["time-off"],
    related: ["time-off-balances"],
    reviewed: REVIEWED,
    limitations: ["Nobody decides their own request."],
  },
  {
    id: "settings-roles-permissions",
    title: "Settings: Roles and permissions",
    summary: "Choose what each role (Office staff, Dispatcher, Mechanic, Driver) can see and do.",
    category: "settings",
    routes: ["/settings"],
    permissions: ["users.manage"],
    audience: "Owners and people who manage users.",
    whatYouSee: [
      "A table of permissions grouped by area, with a checkbox per role.",
      "The Owner / Administrator role always has every permission.",
      "Sign-ins and each person's role are on People → **Sign-ins & roles**.",
    ],
    tasks: [
      {
        title: "Give a role a permission",
        steps: ["Open **Settings** → **Roles and permissions**.", "Tick the box for the role and permission. It takes effect immediately."],
      },
      {
        title: "Change one person's role",
        steps: ["Go to **People** → **Sign-ins & roles**.", "Select **Change role or access**, choose the **Role** and save."],
      },
      {
        title: "Block someone's access",
        steps: ["On **Sign-ins & roles**, select **Change role or access**.", "Untick **Account active (unchecking blocks all access)** and save."],
      },
    ],
    prerequisites: ["Needs the permission to manage users."],
    troubleshooting: [
      { problem: "“Owner permissions cannot be changed.”", fix: "Owners always have every permission." },
      { problem: "A person still cannot open a page after you ticked a permission.", fix: "Check that their role is the one you changed, and that they are not limited to other bases." },
    ],
    next: ["people"],
    related: ["getting-started", "settings-audit-log"],
    reviewed: REVIEWED,
    limitations: ["Permissions are checked by the server and again by the database."],
  },
  {
    id: "settings-sample-data",
    title: "Settings: Sample data",
    summary: "See and remove the fictional training records before you go live.",
    category: "settings",
    routes: ["/settings"],
    permissions: ["settings.manage"],
    audience: "Owners and administrators.",
    whatYouSee: [
      "Counts of sample records by kind.",
      "Sample records are shown with a **Sample** badge elsewhere in the app.",
      "**Remove all sample data**.",
    ],
    tasks: [
      {
        title: "Remove sample data before go-live",
        steps: [
          "Open **Settings** → **Sample data**.",
          "Select **Remove all sample data**.",
          "Read what will be deleted and confirm with **Remove sample data**. This cannot be undone.",
        ],
      },
      {
        title: "Find sample records",
        steps: ["Look for the **Sample** badge on customers, quotes and other records."],
      },
    ],
    prerequisites: ["Needs the permission to manage company settings."],
    troubleshooting: [
      { problem: "**Remove all sample data** is greyed out.", fix: "There is no sample data left." },
      { problem: "A sample material is still listed after removal.", fix: "Sample items used on real quotes are deactivated instead of deleted." },
    ],
    next: ["company-setup"],
    related: ["settings-company"],
    reviewed: REVIEWED,
  },
  {
    id: "settings-audit-log",
    title: "Settings: Audit log",
    summary: "See the latest changes made in your company, who made them and when.",
    category: "settings",
    routes: ["/settings"],
    permissions: ["audit.view"],
    audience: "Owners and administrators.",
    whatYouSee: [
      "The latest 200 changes with **When**, **Who** and **What**, and details on wide screens.",
      "Entries cannot be edited or deleted.",
      "“System” for automatic changes and “Former user” for people no longer in the company.",
    ],
    tasks: [
      {
        title: "Check who changed something",
        steps: ["Open **Settings** → **Audit log**.", "Find the change by time and description."],
      },
      {
        title: "Check a record's own history",
        steps: ["For older changes, open the record itself (order, ticket, work order); most pages have their own **History**."],
      },
    ],
    prerequisites: ["Needs the audit log permission."],
    troubleshooting: [
      { problem: "An older change is not listed.", fix: "Only the latest 200 changes are shown. Use the record's own **History**." },
      { problem: "Pay amounts are not in the log.", fix: "Pay amounts are never written to the audit log." },
    ],
    next: ["settings-roles-permissions"],
    related: ["communications"],
    reviewed: REVIEWED,
  },
];
