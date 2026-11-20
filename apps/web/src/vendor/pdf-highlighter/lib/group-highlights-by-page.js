// Modified for study_paper (M1): page numbers are de-duplicated, so a highlight is rendered once per page it is on.
const groupHighlightsByPage = (highlights) => highlights.reduce((acc, highlight) => {
    if (!highlight) {
        return acc;
    }
    // study_paper: unique page numbers (the bounding rect's page was listed again for every rect on it, so a
    // highlight was rendered once per rect + 1 on its page).
    const pageNumbers = [...new Set([
        highlight.position.boundingRect.pageNumber,
        ...highlight.position.rects.map((rect) => rect.pageNumber || 0),
    ])];
    pageNumbers.forEach((pageNumber) => {
        acc[pageNumber] ||= [];
        const pageSpecificHighlight = {
            ...highlight,
            position: {
                ...highlight.position,
                rects: highlight.position.rects.filter((rect) => pageNumber === rect.pageNumber),
            },
        };
        acc[pageNumber].push(pageSpecificHighlight);
    });
    return acc;
}, {});
export default groupHighlightsByPage;
