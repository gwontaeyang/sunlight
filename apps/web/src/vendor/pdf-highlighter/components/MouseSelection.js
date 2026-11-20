// Modified for study_paper (M2, BRIEF_C C1): the page offset of the selection comes from getBoundingClientRect of the
// page and the container (the same frame as getContainerCoords) instead of offsetTop/offsetLeft, so the scaled rect is
// exact wherever the page's offsetParent is; no screenshot of the page canvas is taken (the app renders the area
// itself at its own scale — AreaCapture.ts), `image` is undefined.
// Modified for study_paper (M2 fix round 1): the drag state lives in refs, the listeners are registered once, and the
// end point is taken from the mouseup event itself. Upstream re-registered the listeners in an effect after every
// state change, so a mouseup (or mousemove) that arrived before React committed the previous move read a stale
// start / end: the selected rect could end where an earlier mousemove was, not where the button was released.
import React, { useEffect, useRef, useState } from "react";
import { asElement, getPageFromElement, isHTMLElement } from "../lib/pdfjs-dom";
import "../style/MouseSelection.css";
import { viewportPositionToScaled } from "../lib/coordinates";
const getBoundingRect = (start, end) => {
    return {
        left: Math.min(end.x, start.x),
        top: Math.min(end.y, start.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
    };
};
const getContainerCoords = (container, pageX, pageY) => {
    const containerBoundingRect = container.getBoundingClientRect();
    return {
        x: pageX - containerBoundingRect.left + container.scrollLeft,
        y: pageY - containerBoundingRect.top + container.scrollTop - window.scrollY,
    };
};
/**
 * A component that enables the creation of rectangular and interactive mouse
 * selections within a given container. NOTE: This does not disable selection in
 * whatever container the component is placed in. That must be handled through
 * the component's events.
 *
 * @category Component
 * @internal
 */
export const MouseSelection = ({ viewer, onSelection, onReset, onDragStart, enableAreaSelection, onChange, style, }) => {
    // Drawn box only; the listeners read drag (study_paper, see the header).
    const [start, setStart] = useState(null);
    const [end, setEnd] = useState(null);
    const drag = useRef({ start: null, end: null, locked: false });
    const rootRef = useRef(null);
    // Needed in order to grab the page info of a mouse selection
    const startTargetRef = useRef(null);
    // study_paper: the latest props for the listeners registered once.
    const props = useRef({ viewer, onSelection, onReset, onDragStart, enableAreaSelection });
    props.current = { viewer, onSelection, onReset, onDragStart, enableAreaSelection };
    const reset = () => {
        props.current.onReset && props.current.onReset();
        drag.current = { start: null, end: null, locked: false };
        setStart(null);
        setEnd(null);
    };
    const resetRef = useRef(reset);
    resetRef.current = reset;
    useEffect(() => {
        onChange && onChange(Boolean(start && end));
    }, [start, end]);
    // Register event listeners once (study_paper: they read the refs)
    useEffect(() => {
        if (!rootRef.current)
            return;
        // Should be the PdfHighlighter
        const container = asElement(rootRef.current.parentElement);
        const handleMouseUp = (event) => {
            const d = drag.current;
            if (!d.start || d.locked || !startTargetRef.current)
                return;
            // study_paper: the end is where the button was released.
            const end = getContainerCoords(container, event.pageX, event.pageY);
            const boundingRect = getBoundingRect(d.start, end);
            // Check if the bounding rectangle has a minimum width and height
            // to prevent recording selections with 0 area
            const shouldEnd = boundingRect.width >= 1 && boundingRect.height >= 1;
            if (!container.contains(asElement(event.target)) || !shouldEnd) {
                resetRef.current();
                return;
            }
            drag.current = { start: d.start, end, locked: true };
            setEnd(end);
            const page = getPageFromElement(startTargetRef.current);
            if (!page)
                return;
            // study_paper: page box in container coordinates (see the header).
            const containerBox = container.getBoundingClientRect();
            const pageBox = page.node.getBoundingClientRect();
            const pageLeft = pageBox.left - containerBox.left + container.scrollLeft;
            const pageTop = pageBox.top - containerBox.top + container.scrollTop;
            const pageBoundingRect = {
                ...boundingRect,
                top: boundingRect.top - pageTop,
                left: boundingRect.left - pageLeft,
                pageNumber: page.number,
            };
            const viewportPosition = {
                boundingRect: pageBoundingRect,
                rects: [],
            };
            const scaledPosition = viewportPositionToScaled(viewportPosition, props.current.viewer);
            const { onSelection } = props.current;
            onSelection &&
                onSelection(viewportPosition, scaledPosition, undefined, () => resetRef.current(), event);
        };
        const handleMouseMove = (event) => {
            const d = drag.current;
            if (!d.start || d.locked)
                return;
            const end = getContainerCoords(container, event.pageX, event.pageY);
            drag.current = { ...d, end };
            setEnd(end);
        };
        const handleMouseDown = (event) => {
            const shouldStart = (event) => props.current.enableAreaSelection(event) &&
                isHTMLElement(event.target) &&
                Boolean(asElement(event.target).closest(".page"));
            // If the user clicks anywhere outside a tip, reset the selection
            const shouldReset = (event) => drag.current.start &&
                !asElement(event.target).closest(".PdfHighlighter__tip-container");
            if (!shouldStart(event)) {
                if (shouldReset(event))
                    resetRef.current();
                return;
            }
            startTargetRef.current = asElement(event.target);
            props.current.onDragStart && props.current.onDragStart(event);
            const start = getContainerCoords(container, event.pageX, event.pageY);
            drag.current = { start, end: null, locked: false };
            setStart(start);
            setEnd(null);
        };
        container.addEventListener("mousemove", handleMouseMove);
        container.addEventListener("mousedown", handleMouseDown);
        document.addEventListener("mouseup", handleMouseUp);
        return () => {
            container.removeEventListener("mousemove", handleMouseMove);
            container.removeEventListener("mousedown", handleMouseDown);
            document.removeEventListener("mouseup", handleMouseUp);
        };
    }, []);
    return (React.createElement("div", { className: "MouseSelection-container", ref: rootRef }, start && end && (React.createElement("div", { className: "MouseSelection", style: { ...getBoundingRect(start, end), ...style } }))));
};
