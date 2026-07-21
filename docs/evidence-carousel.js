export function buildEvidenceCarouselState(attachments, requestedIndex = 0) {
  const items = Array.isArray(attachments) ? attachments : [];
  const total = items.length;
  if (!total) {
    return {
      activeIndex: 0,
      activeId: null,
      positionLabel: "0 张",
      canNavigate: false,
      previousIndex: 0,
      nextIndex: 0,
    };
  }

  const numericIndex = Number.isFinite(requestedIndex) ? Math.trunc(requestedIndex) : 0;
  const activeIndex = ((numericIndex % total) + total) % total;
  return {
    activeIndex,
    activeId: items[activeIndex]?.id || null,
    positionLabel: `${activeIndex + 1} / ${total} 张`,
    canNavigate: total > 1,
    previousIndex: (activeIndex - 1 + total) % total,
    nextIndex: (activeIndex + 1) % total,
  };
}
