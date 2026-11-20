// Modified for study_paper (S0, pdf.js 6.5.438 + React 19): pdfToViewport uses convertToViewportPoint (convertToViewportRectangle was removed in pdf.js 6).
// Modified for study_paper (M1, review M11): viewportPositionToScaled / scaledPositionToViewport convert every rect with the viewport of ITS OWN page (rect.pageNumber), not the bounding rect's page, so rects on pages of different size are normalised correctly.
/** @category Utilities */
export const viewportToScaled = (rect, { width, height }) => {
    return {
        x1: rect.left,
        y1: rect.top,
        x2: rect.left + rect.width,
        y2: rect.top + rect.height,
        width,
        height,
        pageNumber: rect.pageNumber,
    };
};
// study_paper: viewport of the rect's own page (1-indexed pageNumber), falling back to the bounding rect's page.
const pageViewport = (viewer, pageNumber, fallbackPageNumber) => viewer.getPageView((pageNumber || fallbackPageNumber) - 1).viewport;
/** @category Utilities */
export const viewportPositionToScaled = ({ boundingRect, rects }, viewer) => {
    const pageNumber = boundingRect.pageNumber;
    const scale = (obj) => viewportToScaled(obj, pageViewport(viewer, obj.pageNumber, pageNumber));
    return {
        boundingRect: scale(boundingRect),
        rects: (rects || []).map(scale),
    };
};
const pdfToViewport = (pdf, viewport) => {
    // pdf.js 6 removed PageViewport.convertToViewportRectangle; convert both corners instead.
    const [x1, y1] = viewport.convertToViewportPoint(pdf.x1, pdf.y1);
    const [x2, y2] = viewport.convertToViewportPoint(pdf.x2, pdf.y2);
    return {
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y1 - y2),
        pageNumber: pdf.pageNumber,
    };
};
/** @category Utilities */
export const scaledToViewport = (scaled, viewport, usePdfCoordinates = false) => {
    const { width, height } = viewport;
    if (usePdfCoordinates) {
        return pdfToViewport(scaled, viewport);
    }
    if (scaled.x1 === undefined) {
        throw new Error("You are using old position format, please update");
    }
    const x1 = (width * scaled.x1) / scaled.width;
    const y1 = (height * scaled.y1) / scaled.height;
    const x2 = (width * scaled.x2) / scaled.width;
    const y2 = (height * scaled.y2) / scaled.height;
    return {
        left: x1,
        top: y1,
        width: x2 - x1,
        height: y2 - y1,
        pageNumber: scaled.pageNumber,
    };
};
/** @category Utilities */
export const scaledPositionToViewport = ({ boundingRect, rects, usePdfCoordinates }, viewer) => {
    const pageNumber = boundingRect.pageNumber;
    const scale = (obj) => scaledToViewport(obj, pageViewport(viewer, obj.pageNumber, pageNumber), usePdfCoordinates);
    return {
        boundingRect: scale(boundingRect),
        rects: (rects || []).map(scale),
    };
};
