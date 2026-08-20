// Shared behaviour for every page. Kept small and dependency free on purpose.
(function () {
  var yr = document.getElementById('yr');
  if (yr) yr.textContent = new Date().getFullYear();

  var hdr = document.getElementById('hdr');
  if (hdr) {
    var onScroll = function () { hdr.classList.toggle('scrolled', window.scrollY > 12); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  var burger = document.getElementById('burger'), mm = document.getElementById('mobileMenu');
  if (burger && mm) {
    burger.addEventListener('click', function () {
      var open = mm.classList.toggle('show');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    mm.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        mm.classList.remove('show');
        burger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Reveal on scroll, but never at the cost of the content. If the observer is
  // missing or throws, everything is shown at once instead of staying hidden.
  var reveals = document.querySelectorAll('.reveal');
  var showAll = function () { reveals.forEach(function (el) { el.classList.add('in'); }); };
  if (typeof IntersectionObserver !== 'function') {
    showAll();
  } else {
    try {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        });
      }, { threshold: 0.12 });
      reveals.forEach(function (el) { io.observe(el); });
    } catch (err) {
      showAll();
    }
  }
})();
