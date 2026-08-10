/**
 * Help content.
 *
 * Kept apart from the controller because it is prose, not logic, and because the honesty
 * of some of it matters enough to be easy to find and revise. In particular the page on
 * removal: deleting an installed web app deletes its data with it, on both platforms,
 * with no warning from the operating system. Someone who has trusted this app with a
 * boarding pass deserves to have been told that plainly beforehand — not to discover it
 * the morning they travel.
 *
 * Written for a person, not a developer. No jargon, no "cache", no "IndexedDB".
 */

export function helpPages(platform) {
  return [
    {
      title: 'Install',
      body: platform.iosNonSafari ? iosOtherBrowser(platform) : platform.iOS ? iosInstall() : androidInstall(platform),
    },
    {
      title: 'How to use the app',
      body: howToUse(platform),
    },
    {
      title: 'How it works',
      body: howItWorks(),
    },
    {
      title: 'Managing tickets',
      body: managing(),
    },
    {
      title: 'Removing the app',
      body: removing(),
    },
    {
      title: 'Data privacy',
      body: privacy(),
    },
    {
      title: 'About',
      body: about(),
    },
  ];
}

/**
 * The whole journey, in order.
 *
 * Replaces a page that only covered adding a ticket. Someone opening help usually wants
 * to know what happens next, not just how to start.
 */
function howToUse(platform) {
  return `
<p class="help-lead">Four steps, and the app does most of them.</p>

<h3>1. Add a ticket</h3>
<p>Tap <strong>+</strong> and choose your ticket. Three kinds work:</p>
<ul class="help-list">
  <li><strong>A PDF</strong> — the most accurate, because the text is read directly
  rather than recognised from a picture.</li>
  <li><strong>A photo or screenshot</strong> — the barcode usually reads well, but the
  printed details cannot be read from an image, so you will type a few in.</li>
  <li><strong>An email</strong> — many tickets are never a file at all, just the body of
  a message. Save the email, or copy it and paste it in.</li>
</ul>
${platform.android ? `
<div class="help-note">
  <strong>On Android you can share straight in.</strong> Open the ticket in Gmail or
  Files, tap Share, and pick Stub.
</div>` : ''}
${platform.iOS ? `
<div class="help-note">
  <strong>On iPhone, open the app first.</strong> Safari does not let apps like this
  appear in the Share sheet, so tickets are added from inside the app rather than shared
  into it.
</div>` : ''}

<h3>2. Check the details</h3>
<p>Anything read from the ticket is shown for you to confirm. Fields we were unsure of
are listed first, under <em>Please check these</em> — tap <em>That's right</em>, or type
a correction.</p>
<p>Booking references, dates, service numbers and seats are checked hardest, because
those are what get looked at when you travel. Where a detail could not be read it is left
blank rather than guessed, and you can fill it in yourself.</p>

<h3>3. Save it</h3>
<p>The ticket appears on your list, with the next journey shown largest.</p>

<h3>4. Show it</h3>
<p>Open a ticket and tap <strong>Show the code</strong>. The screen brightens and stays
awake so a scanner can read it. Tap again to go back.</p>

<div class="help-note">
Keep your original ticket with you. Some staff will want to see it, and a phone can
always run out of battery.
</div>`;
}

/**
 * Why the app can be trusted, in terms of what it does rather than what it promises.
 *
 * The user asked for this to be explained as "air-gapping", which is the right instinct:
 * the point is not that we promise not to send anything, but that there is nothing to
 * send it to.
 */
function howItWorks() {
  return `
<p class="help-lead">Your ticket never leaves your phone, because there is nowhere for it
to go.</p>

<h3>There is no server</h3>
<p>Most apps send your file somewhere to be processed, then send the result back. This
one does not. The whole app — reading PDFs, decoding barcodes, drawing your pass — runs
inside your browser, on your device.</p>
<p>That is not a promise about how we behave. It is a description of what the app is:
there is no account to create, no address to upload to, and no company holding a copy.</p>

<h3>How a ticket is read</h3>
<p>When you add a ticket, the app opens it here and looks for two things: the text
printed on it, and the barcode. The text tells us your flight number, seat, and dates.
The barcode is what a scanner actually reads.</p>

<h3>The barcode is copied, never redrawn</h3>
<p>The code is lifted exactly as it is — the same data, byte for byte — and shown again
unchanged. It is never rebuilt from the details we read.</p>
<p>This matters more than anything else here. A barcode that looks right but scans to
something different would fail you at a gate, with no warning and no way to tell until
it is too late.</p>

<h3>Nothing is hidden</h3>
<p>Every detail records where it came from: the barcode, the printed text, or your own
correction. Open a ticket and scroll down to see it.</p>

<h3>It keeps working with no signal</h3>
<p>The app stores itself on your device the first time you open it, so it starts on a
plane, in a tunnel, or abroad with no roaming. It never needs a connection to show you a
ticket.</p>`;
}

function iosOtherBrowser(platform) {
  return `
    <p class="help-lead">On iPhone, only Safari can add an app to the Home Screen.</p>
    <p>
      That is Apple's restriction, not ours. ${platform.name} on iPhone uses the same
      engine as Safari underneath, but Apple does not offer <strong>Add to Home
      Screen</strong> anywhere except Safari itself.
    </p>
    <ol class="help-steps">
      <li>Tap <strong>Share</strong>, then <strong>Open in Safari</strong>.</li>
      <li>In Safari, tap <strong>Share</strong> again.</li>
      <li>Scroll down and choose <strong>Add to Home Screen</strong>.</li>
      <li>Tap <strong>Add</strong>.</li>
    </ol>
    <div class="help-note">
      You can carry on using ${platform.name} for everything else. Only the installation
      has to happen in Safari, and only once.
    </div>`;
}

    /**
     * Adding to the Home Screen on iOS.
     *
     * Written to cover both Safari layouts. iOS 18 moved the Share button off the toolbar
     * and into a menu behind a chevron at the end of the address bar, so the old instruction
     * — "tap Share in the toolbar" — sends people looking for a button that is no longer
     * there. Describing both, in the order most people will meet them, is more useful than
     * trying to detect the version and guessing wrong.
     */
    function iosInstall() {
      return `
    <p class="help-lead">On iPhone and iPad, Safari adds this to your Home Screen.</p>
    <ol class="help-steps">
      <li>
        <strong>Open Safari's menu.</strong>
        On newer iPhones, tap the <strong>⌄</strong> chevron at the right-hand end of the
        address bar. On older ones, tap <strong>Share</strong> in the toolbar at the bottom —
        the square with an arrow coming out of the top.
      </li>
      <li><strong>Scroll down</strong> and tap <strong>Add to Home Screen</strong>.</li>
      <li><strong>Tap Add.</strong> The icon appears with your other apps.</li>
    </ol>
    <div class="help-note">
      <strong>Can't find it?</strong> Apple moved this in iOS 18. If there is no Share button
      in the toolbar, it is inside the chevron menu next to the address — along with
      <em>Add to Home Screen</em>.
    </div>
    <div class="help-note">
      <strong>Open it from the icon after that.</strong> The Home Screen version and the
      Safari tab keep separate tickets, so add tickets in the one you actually use. If you
      add it twice you will get two icons, each with its own tickets.
    </div>
    <p>There is no App Store, no account, and nothing to pay.</p>`;
    }

function androidInstall(platform) {
  if (platform.firefox) {
    return `
      <p class="help-lead">Firefox offers only limited support for installing apps like this.</p>
      <p>
        Everything works perfectly well in the browser — tickets are saved, and it still
        works offline. But for a proper icon on your home screen, Chrome, Edge, Brave,
        Opera or Samsung Internet will install it fully.
      </p>
      ${platform.android ? `<ol class="help-steps">
        <li>Open Firefox's menu.</li>
        <li>Choose <strong>Install</strong> or <strong>Add to Home screen</strong> if it is offered.</li>
      </ol>` : ''}
      <div class="help-note">
        Your tickets stay in whichever browser you added them to. They are not shared
        between browsers, because nothing is uploaded anywhere.
      </div>`;
  }

  return `
    <p class="help-lead">${platform.name} installs this like any other app.</p>
    <ol class="help-steps">
      <li><strong>Tap Install</strong> when it is offered, or open the menu and choose
        <strong>Install app</strong>${platform.touch ? '' : ' — or use the install icon in the address bar'}.</li>
      <li><strong>Confirm.</strong> The icon appears with your other apps.</li>
    </ol>
    <p>It behaves like an installed app: its own icon, its own window, and it works offline.</p>
    <div class="help-note">
      <strong>On a computer?</strong> Scan the code on the front page to open this on your
      phone, which is where tickets are actually useful.
    </div>
    <p>There is no Play Store listing, no account, and nothing to pay.</p>`;
}

function managing() {
  return `
    <p class="help-lead">Tickets are yours to remove, and yours to take with you.</p>

    <h3>Removing one ticket</h3>
    <p>Open it and use the menu in the corner. That ticket goes; everything else stays.
    Your original file is never touched.</p>

    <h3>Past journeys</h3>
    <p>A ticket moves to <strong>Past</strong> six hours after it departs, rather than
    disappearing. Delays happen, and the booking reference is often needed weeks later for
    a refund or an expense claim.</p>

    <h3>Backing up</h3>
    <p>In <strong>Settings</strong>, tap <strong>Export a backup</strong>. You get a single
    file holding every ticket, which you can keep wherever you like. <strong>Restore from a
    backup</strong> brings them all back.</p>

    <div class="help-note">
      The backup is ordinary readable text. Nothing is locked to this app, and you can
      move your tickets elsewhere whenever you want.
    </div>`;
}

function removing() {
  return `
    <div class="help-warning">
      <strong>Deleting this app deletes your tickets with it.</strong>
      On both iPhone and Android, removing an app like this one removes everything stored
      inside it. There is no way to recover it afterwards, and nobody else has a copy —
      that is the direct consequence of nothing being uploaded anywhere.
    </div>

    <p><strong>Export a backup first</strong> if you might want your tickets again. It
    takes a moment, and it is the only way back.</p>

    <h3>How to remove it</h3>
    <p><strong>iPhone:</strong> press and hold the icon, then Remove App, then Delete App.</p>
    <p><strong>Android:</strong> press and hold the icon, then Uninstall.</p>

    <h3>Keeping the app, clearing the tickets</h3>
    <p>If you only want to start fresh, use <strong>Delete every ticket</strong> in
    Settings. The app stays where it is.</p>

    <h3>If your browser clears it</h3>
    <p>When installed, this app asks your browser to keep its data safe, and browsers
    normally agree for apps added to the Home Screen. If yours declines, Settings will say
    so — take a backup in that case.</p>`;
}

    function privacy() {
      return `
    <p class="help-lead">We hold nothing about you, because we hold nothing at all.</p>

    <h3>What is collected</h3>
    <p>Nothing. There is no account, no sign-in, no analytics, no advertising, no crash
    reporting, and no third-party code loaded while you use the app. Nobody is counting how
    many people opened it, including us.</p>

    <h3>What is stored, and where</h3>
    <p>Your tickets are saved in your browser's own storage, on your device. That includes
    the details we read, the barcode, and the artwork drawn for each pass.</p>
    <p>Nobody else can see it. Not us, not your network, not the site this app was
    downloaded from.</p>

    <h3>You can take it with you</h3>
    <p>Settings has an <strong>Export</strong> button that writes everything to a file you
    keep. Import it on another device, or hold it as a backup. Your data is not locked
    inside this app.</p>

    <h3>Deleting is real deletion</h3>
    <p>Remove a ticket and it is gone from your device. Remove the app from your home screen
    and everything in it goes too — see <em>Removing the app</em>. There is no copy on a
    server to ask us to delete, because there was never a server.</p>

    <h3>Your choice about what is kept</h3>
    <p>Settings lets you decide what happens after you travel: keep tickets for your records,
    or have them cleared automatically. It is your call, and you can change it whenever you
    like.</p>

    <div class="help-note">
    This app is not issued by any airline, railway or operator. It reads tickets you already
    have. Keep your original with you.
    </div>`;
    }

    /**
     * Who made it and why.
     *
     * The motivation is worth stating plainly: this exists because of the small indignity of
     * opening a photo gallery in front of someone at a gate.
     */
    function about() {
      return `
    <p class="help-lead">Tickets belong in a wallet, not in a photo gallery.</p>

    <p>Everyone has stood at a gate, holding up the queue, scrolling through screenshots or
    pinching around a PDF while someone waits. Your ticket is right there on your phone and
    still somehow hard to produce.</p>

    <p>Stub was built to fix that one small indignity. Add a ticket, and it becomes a pass
    you can open in a second and hold up to a scanner — with no account, no upload, and
    nothing asked of you in return.</p>

    <h3>Free, and free of lock-in</h3>
    <p>There is nothing to pay, no subscription, and nothing to unlock. There is also no
    trap: your tickets export to a file you keep, and the app can be removed completely at
    any time.</p>

    <h3>Open</h3>
    <p>The code is public. Anyone can read exactly what it does with a ticket — which is the
    only way a claim like "nothing leaves your device" can be worth anything.</p>
    <p><a href="https://github.com/tejaswiMSFT/stub" target="_blank" rel="noopener">github.com/tejaswiMSFT/stub</a></p>

    <div class="help-note">
    Vibe coded by Tejaswi · Built with 💓 and Microsoft Scout.
    </div>`;
}
