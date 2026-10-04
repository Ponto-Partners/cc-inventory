# CC Medical Inventory

A simple inventory and customer tracker for CC Medical's warehouse.

**Live at https://ccmedical.app** (also https://cc-medical-inventory.rciesco-bff.workers.dev). Code: github.com/Ponto-Partners/cc-inventory. Every push to `main` deploys automatically.

It runs on Cloudflare:

- **Cloudflare Worker** serves the app and its API
- **Cloudflare D1** (Cloudflare's built-in database) stores items, customers, users and the button choices
- **Username (or email address) + password sign-in**. Passwords are salted and hashed (PBKDF2). Sessions last 30 days. Five wrong tries lock that account for 10 minutes.

**Plans: Workers Free while testing, Workers Paid ($5 a month) at go-live.** The free plan allows 10 ms of CPU per request. A full-strength password check takes about 18 ms, so while on the free plan the app hashes passwords at 20,000 rounds (about 4 ms) instead of 100,000. That setting is `PBKDF2_ITERATIONS` in `wrangler.toml`.

**At go-live:**
1. Upgrade the Cloudflare account to Workers Paid.
2. In `wrangler.toml`, change `PBKDF2_ITERATIONS = "20000"` to `"100000"`.
3. Push to GitHub (it deploys itself), or run `npx wrangler deploy`.

Nobody has to reset a password: each one is re-saved at full strength the next time that person signs in. Workers Paid also keeps 30 days of database restore points instead of 7.

## What's in the folder

```
package.json                  Pins the Wrangler version and holds shortcuts: npm run dev / deploy / db:init / db:backup
wrangler.toml                 Cloudflare settings (you paste your database ID here)
schema.sql                    Creates the database tables and the starting buttons
src/worker.js                 The server: sign-in, inventory, Product History, customers, users
public/                       The app people use: index.html, app.css, app.js, logo.svg, logo-white.svg
public/icons/, manifest      Home-screen icon and install settings for phones
public/vendor/                Barcode scanner (html5-qrcode, Apache-2.0) and QR code maker (qrcode-generator, MIT)
tools/import_inventory.py     Turns Inventory_Ultrasound.xlsx into a review workbook, then into import.sql
migrations/                   Only for a database set up with an earlier version of schema.sql
```

## Deploy it (about 15 minutes, one time)

You need [Node.js](https://nodejs.org) 18 or newer and a Cloudflare account.

1. **Open a terminal in this folder and sign in to Cloudflare**
   ```
   npx wrangler login
   ```
2. **Create the database**
   ```
   npx wrangler d1 create cc-inventory
   ```
   It prints a `database_id`. Paste it into `wrangler.toml` in place of `REPLACE_WITH_YOUR_DATABASE_ID`.
3. **Create the tables and starting buttons** (if you set up an earlier version of this app, run `migrations/upgrade-from-first-version.sql` first)
   ```
   npx wrangler d1 execute cc-inventory --remote --file=schema.sql
   ```
4. **Load the existing inventory** (once, before staff start receiving). See *Importing the spreadsheet* below; the last step is:
   ```
   npx wrangler d1 execute cc-inventory --remote --file=import.sql
   ```
5. **Publish**
   ```
   npx wrangler deploy
   ```
   It prints your address, like `https://cc-medical-inventory.<your-account>.workers.dev`.
6. **Create the admin account right away.** Open that address. The first visit shows **Create the admin account**. Whoever completes it becomes the admin, so do it immediately after deploying.
7. **Add your team** with the **Admin** button (top right, next to your name). Give each person their username and temporary password. They can change it from the menu under their name.

### Deploy from GitHub (recommended)
Keep this folder in a private GitHub repository and let Cloudflare deploy every push to `main`:

1. Push this folder to a private GitHub repository. The `.gitignore` keeps spreadsheets, `import.sql` and backups out of it, so customer data never lands in GitHub.
2. In the Cloudflare dashboard: **Workers & Pages** → the `cc-medical-inventory` Worker → **Settings** → **Builds** → **Connect**, and pick the repository. The Worker's name must match `name` in `wrangler.toml`.
3. Leave the deploy command as `npx wrangler deploy`. Each push to `main` now deploys automatically; other branches get a preview link.

Builds are included on the free plan (3,000 build minutes a month). The database setup (`schema.sql`) and the one-time import are still run once from a computer with `npx wrangler d1 execute …`; deploys never touch the data.

### Use your own domain (optional)
In the Cloudflare dashboard: **Workers & Pages → cc-medical-inventory → Settings → Domains & Routes → Add → Custom domain**, for example `ccmedical.app` (in use now) or `inventory.ccmedicalhs.com`. The domain's DNS has to be on Cloudflare. A new domain's security certificate takes a few minutes to issue; until then browsers show ERR_SSL_VERSION_OR_CIPHER_MISMATCH.

### Branding
The app uses CC Medical's own logo files (`public/logo.svg` and `public/logo-white.svg`, from ccmedicalhs.com) and the brand colors from that logo, set at the top of `public/app.css`:
```css
--brand:#231F20;     /* CC Medical near-black: wordmark and headings */
--brand-2:#6A4694;   /* CC Medical purple: buttons, selections, sign-in screen */
```
To update the logo later, replace those two files and run `npx wrangler deploy`.

## Tabs

The header reads **Inventory / Product History / CRM Tool Set**, the app's three jobs. The four tabs:

- **Receive New Inventory**: the tap-through intake below
- **Current Inventory**: search and filter, change status, send items out. Shows units in stock, units on loan, open repairs, returns to check, and the value on hand (cost × quantity of everything in stock, pending or on loan). Sold and closed records are hidden unless you tap **Show**, search, or filter by status.
- **Product History**: every serial-numbered unit and everything that's happened to it
- **Customers**: contacts plus every item tied to each customer

## Receive New Inventory

Workers tap through big buttons, one question per screen.

**Step 1 starts with a serial number box.** Scan or type a serial and tap **Look up**:
- **Seen before:** it shows the unit (manufacturer, model, part #), how many times it's been received, its latest status and customer, and recent history. If the unit is still open (for example out on rental), it says so. Tap the type below and the manufacturer, model, part number, category and customer fill in, jumping straight to Condition.
- **New:** it says so. Pick the type and carry on; the serial is added to the registry when you save.

Then Step 1 picks one of four types:

- **New stock**: probes, systems or parts going on the shelf
- **Customer repair**: repair it and send it back
- **Customer return**: equipment a customer is sending back (end of rental, wrong item, defective…)
- **Core return**: an old unit sent back for core credit

| Step | New stock | Customer repair | Customer return | Core return |
|---|---|---|---|---|
| 2 | Manufacturer or part # | same | same | same |
| 3 | Model | Model | Model | Model |
| 4 | Category | Category | Category | Category |
| 5 | Condition | Condition | Condition | Condition |
| 6 | Details → **Save** | Customer | Customer | Customer |
| 7 | | Problems (tap all) | Return reason (tap all) | Details → **Save** |
| 8 | | Details → **Save** | Details → **Save** | |

Details are quantity, part number, serial, cost per unit, date of manufacture (YYYY-MM), shelf/bin and notes. Repairs, returns and cores also get an optional **RMA / order #**.

**Part numbers.** On step 2, type or scan a part number and tap **Look up**. If that part number has been received before, the manufacturer, model and category fill in and it jumps to Condition. If it's new, pick the manufacturer as usual; the part number is saved with the item, so it auto-fills from then on. Picking a model that's been received before also fills in its category.

- Any screen has **+ Add new**. Whatever is typed becomes a button for everyone from then on.
- The chosen answers stay at the top. Tap one to go back and change it.
- Saving shows a tag number such as `CC-261003-7K2Q` to write on the box.
- **Another of the same** keeps every answer and clears the serial number, for receiving a batch quickly.
- Barcode scanners that type like a keyboard work in the serial field.

### Starting buttons
Categories: Ultrasound probe, Ultrasound system, System part, Accessory.
Conditions: New, Refurbished, Used, New - open box, Demo, Compatible, Damaged / for parts.
Manufacturers: GE Healthcare, Philips, Siemens, Canon / Toshiba, Mindray / Zonare, Samsung, SonoSite / Fujifilm, BK Medical, Hitachi.
Repair problems: No image, Dropout / dead elements, Cracked or damaged lens, Cable damage, Delamination, Not recognized by system, Housing crack.
Return reasons: Rental ended, Defective / not working, Wrong item shipped, No longer needed, Warranty claim.
The spreadsheet import adds every model (about 250) and bin (A1–A4, B1–B4, C1–C2, R2, T2, T3) it finds. After that, models and bins grow as people add them.

## Scanning with a phone

Every place you'd type a code has a **Scan** button: the serial number on step 1, the part number on step 2, the serial and part number on the last details screen, and the search on Current Inventory and Product History.

- It opens the phone's camera. Hold the barcode or QR label inside the box and it fills the field on its own. If live video isn't available, **Take a photo** reads the code from a picture instead.
- It reads QR, Data Matrix, Code 128, Code 39, Code 93, EAN-13, UPC-A and ITF.
- **Scan on Current Inventory** is the quick way to scan things out. A CC Medical tag label opens that record. A serial opens its open record, or its Product History if it has none. Then one tap marks it sold, on loan, rented or pending.
- On step 1, scanning a CC Medical tag uses that unit's serial, so a labeled unit coming back is recognized right away.
- A good read beeps and buzzes, so you know it worked without looking.
- **Flashlight** appears in the scanner on phones that allow it (most Android phones; iPhones don't let web apps use it yet), for dark shelves.
- The camera needs the app's secure (https) address, which Cloudflare provides.

## On a phone

The app is laid out for one-handed use in the warehouse:

- On phones, the sections move to a bar at the bottom: **Receive, Inventory, Scan, History, Customers**. The big **Scan** button in the middle is always in thumb reach. On Receive it fills the serial box; everywhere else it finds the unit (a tag label opens the record; a serial opens its record or its history).
- Current Inventory's numbers and quick filters sit in single rows you swipe sideways, so the list starts near the top.
- Text boxes are large enough that iPhones don't zoom in when tapped, and code fields don't autocorrect or auto-capitalize mid-serial.
- If the phone loses signal in a dead spot, an orange bar says changes can't be saved; it clears and refreshes when the signal is back.
- Tablets and computers keep the folder tabs across the top.

**Install it like an app.** Open the app's address on the phone, sign in, then:
- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** ⋮ menu → **Add to Home screen** or **Install app**.

It gets the CC Medical icon, opens full-screen with no browser bar, and stays signed in for 30 days.

## Tag labels

**Print tag label** appears after saving an intake and on every record. **Print labels for these N** on Current Inventory prints the whole filtered list; use this once after the import to label existing stock.

- Each label has a QR code, the tag number, the make and model, the serial (or part number), the bin, and the date of manufacture.
- The QR code holds a link to the record. The app's Scan button opens it, and so does a phone's own camera app.
- Two sizes: **label printer, 2.25 × 1.25 in** (DYMO 30334 and similar) and **Letter sheets of 30 (Avery 5160)**. The app remembers the choice on each device. In the print dialog, pick the matching paper and set margins to None and scale to 100%.

## Product History (serial number registry)

Every unit received with a serial number gets a permanent entry on the **Product History** tab: manufacturer, model, part number, date of manufacture, times received, first and last seen, and its latest status and customer. Tap one to see:
- every record for that unit (each repair, return, rental and so on)
- a full event history: intake, status changes, rentals, customer changes, serial corrections

This history is kept in its own log and is never deleted, even if an item record is deleted later. When a known unit comes back in, its previous record gets a note ("Unit received again as CC-…"), and the new record notes how many times the serial has been seen. Any item with a serial also has a **Product history** button.

## Statuses

- **Stock:** In stock → Pending → On loan or Out on rental → Sold / shipped
- **Repairs:** Received → Evaluating → Awaiting approval → In repair → Ready to return → Returned
- **Customer returns:** Received → Inspecting → Back in stock / Credit issued → Closed
- **Core returns:** Received → Inspecting → Credit approved / Credit denied → Closed

Sending out part of a quantity (for example 2 of 5) splits those units into their own record with a new tag, so each group has its own status and customer.

## Importing the spreadsheet

`tools/import_inventory.py` turns CC Medical's `Inventory_Ultrasound.xlsx` into app records. It needs Python 3.9+ and openpyxl (`pip install openpyxl`).

The list that turns hospital names in the INFO column into customers is CC Medical's customer list, so it's kept in `tools/customer_names.json`, which never goes to GitHub. Get that file from Richard, or copy `tools/customer_names.example.json` to start one.

1. **Make the review file**
   ```
   python3 tools/import_inventory.py review Inventory_Ultrasound.xlsx Import_Review.xlsx
   ```
   One row per spreadsheet row: the original columns (grey) beside what the app will store (yellow). Rows that need a person are marked **CHECK** with the reason. The **Models** sheet lists every model with its manufacturer and counts; the **Customers** sheet lists the customers made from INFO notes.
2. **Fix** the CHECK rows and anything else that's wrong, in the yellow columns only.
3. **Make the import file**
   ```
   python3 tools/import_inventory.py json Import_Review.xlsx CC_Medical_Import.json
   ```
   It refuses to run if a row has a status, cost or date it can't use, and lists the rows to fix.
4. **Load it:** in the app, an admin taps **Admin**, then **Import spreadsheet data**, chooses `CC_Medical_Import.json` and taps **Import**. It takes a few seconds. Running it twice is safe; anything already loaded is skipped.

   (Command-line alternative: `python3 tools/import_inventory.py sql Import_Review.xlsx import.sql`, then `npx wrangler d1 execute cc-inventory --remote --file=import.sql`.)

The manufacturer written in the untitled column beside a shelf space's first row (GE on A1–A3, Philips on A4, B1 and B2) is applied to every unit stored in that space, unless MODULE names a different maker; rows where the model suggests a different maker than the shelf are marked CHECK.

Imported records get tags that point back to the spreadsheet (row 9 → `CC-IMP-0009`) and a history line naming the row. Sold rows are imported too, as closed records, so the app recognizes a sold unit when it comes back.

## Who can do what

There are two kinds of users:

| | Standard | Admin |
|---|---|---|
| Receive, search, edit, change status, send out | ✓ | ✓ |
| Add and delete customers, items and buttons | ✓ | ✓ |
| Add users, reset passwords, remove or restore access | | ✓ |

Admins see an **Admin** button next to their name at the top. It opens the user access page. Standard users don't see it.

## Backups
Cloudflare D1 keeps automatic point-in-time history ("Time Travel"): 7 days on the free plan, 30 days on Workers Paid. For a copy on your own computer:
```
npx wrangler d1 export cc-inventory --remote --output=backup.sql
```

## Making changes later
Edit the files and run `npx wrangler deploy`. Data in the database isn't touched by a deploy.

## How the app stays up to date
Each open device refreshes every 30 seconds while nobody is typing. The first load fetches everything; later refreshes ask only for what changed since the last one (`/api/data?since=`), so a quiet warehouse costs almost nothing in database reads.
