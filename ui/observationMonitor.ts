export default new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      entry.target.classList.add('observe-visible');
    }
  }
}, { threshold: 0.1 });
