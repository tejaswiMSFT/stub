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

/**
 * Where feedback goes.
 *
 * The subject is prefilled so a message arrives already identified as being about this
 * app rather than anything else on the site.
 */
const CONTACT_URL = 'https://tejaswimsft.github.io/?subject=Stub%20—%20feedback#contact';

/**
 * Help pages.
 *
 * Titles are labels, not sentences. They sit in a bar at the top of a sheet and are read
 * at a glance, so "Guide" beats "How to use the app" — and none of them say "tickets",
 * because the app also holds hotel bookings and coupons.
 */
export function helpPages(platform) {
  const pages = [];

  // The install guide is useless to someone reading it inside the installed app — they
  // have already done it. Shown only in a browser, where it is the whole point.
  if (!platform.standalone) {
    pages.push({
      title: 'Install',
      body: platform.iosNonSafari ? iosOtherBrowser(platform) : platform.iOS ? iosInstall() : androidInstall(platform),
    });
  }

  pages.push(
    { title: 'Guide', body: howToUse(platform) },
    { title: 'How it works', body: howItWorks() },
    { title: 'Management', body: managing() },
    { title: 'Uninstall', body: removing() },
    { title: 'Privacy', body: privacy() },
    { title: 'About', body: about() },
  );

  return pages;
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
    <p class="help-lead">Everything here is yours to remove, and yours to take with you.</p>

    <h3>Removing one</h3>
    <p>Open it and use the menu in the corner — <strong>Edit</strong> to correct a detail,
    <strong>Delete</strong> to remove it. That one goes; everything else stays, and your
    original file is never touched.</p>

    <h3>Past journeys</h3>
    <p>A pass moves to <strong>Past</strong> six hours after it departs, rather than
    disappearing. Delays happen, and a booking reference is often needed weeks later for a
    refund or an expense claim.</p>

    <h3>Backing up</h3>
    <p>In <strong>Settings</strong>, tap <strong>Export a backup</strong>. You get a single
    file holding everything you have saved, to keep wherever you like. <strong>Restore from a
    backup</strong> brings it all back.</p>

    <div class="help-note">
      The backup is ordinary readable text. Nothing is locked to this app, and you can
      move your tickets elsewhere whenever you want.
    </div>`;
}

function removing() {
  return `
    <div class="help-warning">
      <strong>Deleting this app deletes your data with it.</strong>
      On both iPhone and Android, removing an app like this one removes everything stored
      inside it. There is no way to recover it afterwards, and nobody else has a copy —
      that is the direct consequence of nothing being uploaded anywhere.
    </div>

    <p><strong>Export a backup first</strong> if you might want any of it again. It takes a
    moment, and it is the only way back.</p>

    <h3>How to remove it</h3>
    <p><strong>iPhone:</strong> press and hold the icon, then Remove App, then Delete App.</p>
    <p><strong>Android:</strong> press and hold the icon, then Uninstall.</p>

    <h3>Keeping the app, clearing the data</h3>
    <p>If you only want to start fresh, use <strong>Delete everything</strong> in Settings.
    The app stays where it is.</p>

    <h3>If your browser clears it</h3>
    <p>When installed, this app asks your browser to keep its data safe, and browsers
    normally agree for apps added to the Home Screen. If yours declines, Settings will say
    so — take a backup in that case.</p>`;
}

    function privacy() {
      return `
    <p class="help-lead">Nothing about you is collected, stored, or sent anywhere.</p>

    <h3>Collected: nothing</h3>
    <p>No account, no sign-in, no analytics, no advertising, no crash reporting. Nobody is
    counting how many people opened this, including us.</p>

    <h3>Stored: on your device only</h3>
    <p>Your tickets are saved in your browser's own storage — the details, the barcode, and
    the artwork. Nobody else can see them. Not us, not your network, not the site this came
    from.</p>

    <h3>Yours to take</h3>
    <p>Settings has an <strong>Export</strong> button that writes everything to a file you
    keep. Deleting is real deletion: remove a ticket and it is gone, remove the app and
    everything goes with it. There is no server copy to ask us about.</p>

    <h3>Your choice on what is kept</h3>
    <p>Settings decides what happens after you travel — keep tickets for your records, or
    have them cleared automatically. Change it whenever you like.</p>

    <div class="help-note">
    This app is not issued by any airline, railway or operator. It reads tickets you already
    have.
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

    <h3>Updates arrive on their own</h3>
<p>There is no App Store here, so improvements reach you the moment they are ready. The
app checks quietly when you open it, downloads anything new in the background, and
switches over when you are not in the middle of something.</p>
<p>It will never block you to force an update. This app exists to show a ticket at a
gate, and an update needs a signal — which is exactly what you do not have on a plane or
in a tunnel. <strong>Your saved tickets are never touched by an update.</strong></p>
<p>Settings shows which version you are on, and can check on demand.</p>

<h3>Open</h3>
    <p>The code is public. Anyone can read exactly what it does with a ticket — which is the
    only way a claim like "nothing leaves your device" can be worth anything.</p>
    <p><a href="https://github.com/tejaswiMSFT/stub" target="_blank" rel="noopener">github.com/tejaswiMSFT/stub</a></p>

    <h3>Something wrong? Something missing?</h3>
    <p>Tickets vary enormously between airlines, railways and countries, and the only way
    this improves is people saying what it got wrong on theirs.</p>
    <p class="help-action">
      <a class="help-button" href="${CONTACT_URL}" target="_blank" rel="noopener">Get in touch</a>
    </p>

    <div class="help-note">
    Vibe coded by Tejaswi · Built with <span class="heartbeat" aria-label="love">❤️</span> and Microsoft Scout.
    </div>`;
    }
