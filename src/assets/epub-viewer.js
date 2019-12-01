/*
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

// 1024 characters per page is used by Adobe Digital Editions
const CHARACTERS_PER_PAGE = 1024
const CHARACTERS_PER_WORD = lang =>
    lang === 'zh' || lang === 'ja' || lang === 'ko' ? 2.5 : 6
const WORDS_PER_MINUTE = 200

let book = ePub()
let rendition
let cfiToc
let sectionMarks = []
let lineHeight = 24
let enableFootnote = false
let skeuomorphism = false
let autohideCursor, myScreenX, myScreenY, cursorHidden
let ibooksInternalTheme = 'Light'
let doubleClickTime = 400
let zoomLevel = 1
let windowSize
const getWindowIsZoomed = () => Math.abs(windowSize - window.innerWidth * zoomLevel) > 2

const CFI = new ePub.CFI()

// create a range cfi from two cfi locations
// adapted from https://github.com/futurepress/epub.js/blob/be24ab8b39913ae06a80809523be41509a57894a/src/epubcfi.js#L502
const makeRangeCfi = (a, b) => {
    const start = CFI.parse(a), end = CFI.parse(b)
    const cfi = {
        range: true,
        base: start.base,
        path: {
            steps: [],
            terminal: null
        },
        start: start.path,
        end: end.path
    }
    const len = cfi.start.steps.length
    for (let i = 0; i < len; i++) {
        if (CFI.equalStep(cfi.start.steps[i], cfi.end.steps[i])) {
            if (i == len - 1) {
                // Last step is equal, check terminals
                if (cfi.start.terminal === cfi.end.terminal) {
                    // CFI's are equal
                    cfi.path.steps.push(cfi.start.steps[i])
                    // Not a range
                    cfi.range = false
                }
            } else cfi.path.steps.push(cfi.start.steps[i])
        } else break
    }
    cfi.start.steps = cfi.start.steps.slice(cfi.path.steps.length)
    cfi.end.steps = cfi.end.steps.slice(cfi.path.steps.length)

    return 'epubcfi(' + CFI.segmentString(cfi.base)
        + '!' + CFI.segmentString(cfi.path)
        + ',' + CFI.segmentString(cfi.start)
        + ',' + CFI.segmentString(cfi.end)
        + ')'
}

const getCfiFromHref = async href => {
    const id = href.split('#')[1]
    const item = book.spine.get(href)
    await item.load(book.load.bind(book))
    const el = id ? item.document.getElementById(id) : item.document.body
    return item.cfiFromElement(el)
}
const getSectionFromCfi = cfi => {
    const index = cfiToc.findIndex(el => el ? CFI.compare(cfi, el.cfi) <= 0 : false)
    return cfiToc[(index !== -1 ? index : cfiToc.length) - 1]
        || { label: book.package.metadata.title, href: '', cfi: '' }
}

const getSelections = () => rendition.getContents()
    .map(contents => contents.window.getSelection())
const clearSelection = () => getSelections().forEach(s => s.removeAllRanges())
const selectByCfi = cfi => getSelections().forEach(s => s.addRange(rendition.getRange(cfi)))

class Find {
    constructor() {
        this.results = []
    }
    _findInSection(q, section) {
        if (!section) section = book.spine.get(rendition.location.start.cfi)
        return section.load(book.load.bind(book))
            .then(section.find.bind(section, q))
            .finally(section.unload.bind(section))
    }
    _findInBook(q) {
        return  Promise.all(book.spine.spineItems.map(item =>
            item.load(book.load.bind(book))
                .then(item.find.bind(item, q))
                .finally(item.unload.bind(item))))
            .then(results =>
                Promise.resolve([].concat.apply([], results)))
    }
    find(q, inBook, highlight) {
        this.clearHighlight()
        return (inBook ? this._findInBook : this._findInSection)(q)
            .then(results => {
                results.forEach(result =>
                    result.section = getSectionFromCfi(result.cfi).label)
                this.results = results
                dispatch({ type: 'find-results', payload: { q, results } })
                if (highlight) this.highlight()
            })
    }
    highlight() {
        this.clearHighlight()
        this.results.forEach(({ cfi }) =>
            rendition.annotations.underline(cfi, {}, () => {}, 'ul', {
                'stroke-width': '3px',
                'stroke': 'red',
                'stroke-opacity': 0.8,
                'mix-blend-mode': 'multiply'
            }))
    }
    clearHighlight() {
        this.results.forEach(({ cfi }) =>
            rendition.annotations.remove(cfi, 'underline'))
    }
}
const find = new Find()

const dispatchLocation = async () => {
    const location = await rendition.currentLocation()

    const percentage = location.start.percentage
    const index = book.spine.get(location.start.cfi).index

    // rough estimate of reading time
    // should be reasonable for English and European languages
    // will be way off for some langauges
    const estimate = endPercentage =>
        (endPercentage - percentage) * book.locations.total
        * CHARACTERS_PER_PAGE
        / CHARACTERS_PER_WORD(book.package.metadata.language)
        / WORDS_PER_MINUTE

    const nextSectionPercentage = (sectionMarks || []).find(x => x > percentage)

    dispatch({
        type: 'relocated',
        payload: {
            atStart: location.atStart,
            atEnd: location.atEnd,
            cfi: location.start.cfi,
            endCfi: location.end.cfi,
            sectionHref: getSectionFromCfi(location.start.cfi).href,
            section: index,
            sectionTotal: book.spine.length,
            location: book.locations.locationFromCfi(location.start.cfi),
            locationTotal: book.locations.total,
            percentage,
            timeInBook: estimate(1),
            timeInChapter: estimate(nextSectionPercentage)
        }
    })
}

const addAnnotation = (cfi, color) => {
    rendition.annotations.remove(cfi, 'highlight')
    rendition.annotations.highlight(cfi, {}, async e => dispatch({
        type: 'highlight-menu',
        payload: {
            position: getRect(e.target),
            cfi,
            text: await book.getRange(cfi).then(range => range.toString()),
            language: book.package.metadata.language
        }
    }), 'hl', {
        fill: color,
        'fill-opacity': 0.25,
        'mix-blend-mode': 'multiply'
    })
}

const speak = from => {
    // speak selection
    const selections = getSelections()
        .filter(s => s.rangeCount && !s.getRangeAt(0).collapsed)
    if (selections.length) return dispatch({
        type: 'speech',
        payload: {
            text: selections[0].toString(),
            nextPage: false
        }
    })
    // otherwise speak current page
    const currentLoc = rendition.currentLocation()
    if (from) {
        const cfi = new ePub.CFI(from)
        cfi.collapse(true)
        from = cfi.toString()
    }
    book.getRange(makeRangeCfi(from || currentLoc.start.cfi, currentLoc.end.cfi))
        .then(range => dispatch({
            type: 'speech',
            payload: {
                text: range.toString(),
                nextPage: !currentLoc.atEnd
            }
        }))
}

// redraw annotations on view changes
// so that they would be rendered at the new, correct positions
const redrawAnnotations = () =>
    rendition.views().forEach(view => view.pane ? view.pane.render() : null)

const setStyle = style => {
    const {
        brightness, fgColor, bgColor, linkColor, invert,
        fontFamily, fontSize, fontWeight, fontStyle, fontStretch,
        spacing, margin,
        usePublisherFont, hyphenate, justify
    } = style

    lineHeight = fontSize * spacing

    ibooksInternalTheme = style.ibooksInternalTheme
    rendition.getContents().forEach(contents => contents.document.documentElement
        .setAttribute('__ibooks_internal_theme', ibooksInternalTheme))

    document.body.style.margin = `0 ${margin}%`
    rendition.resize()

    document.documentElement.style.filter =
        (invert ? 'invert(1) hue-rotate(180deg) ' : '')
        + `brightness(${brightness})`
    document.body.style.color = fgColor
    document.body.style.background = bgColor

    const themeName = usePublisherFont ? 'publisher-font' : 'custom-font'
    const stylesheet = {
        [`.${themeName}`]: {
            'color': fgColor,
            'background': bgColor,
            'font-size': `${fontSize}px !important`,
            'line-height': `${spacing} !important`,
            '-webkit-hyphens': hyphenate ? 'auto' : 'manual',
            '-webkit-hyphenate-limit-before': 3,
            '-webkit-hyphenate-limit-after': 2,
            '-webkit-hyphenate-limit-lines': 2
        },
        [`.${themeName} p`]: {
            'font-size': `${fontSize}px !important`,
            'line-height': `${spacing} !important`
        },
        [`.${themeName} code, .${themeName} pre`]: {
            '-webkit-hyphens': 'none'
        },
        [`.${themeName} a:link`]: { color: linkColor },
        p: {
            'text-align': justify ? 'justify' : 'inherit'
        }
    }

    if (!usePublisherFont) {
        // set custom font
        const bodyStyle = stylesheet[`.${themeName}`]
        bodyStyle['font-family'] = `"${fontFamily}" !important`
        bodyStyle['font-style'] = fontStyle
        bodyStyle['font-weight'] = fontWeight
        bodyStyle['font-stretch'] = fontStretch

        // force font on everything that isn't code
        const notCode = '*:not(code):not(pre):not(code *):not(pre *)'
        stylesheet[`.${themeName} ${notCode}`] = {
            'font-family': '"${fontFamily}" !important'
        }
    }

    rendition.themes.register(themeName, stylesheet)
    rendition.themes.select(themeName)
    redrawAnnotations()
}

/*
Steps when opening a book:

open() -> 'book-ready' -> loadLocations()
                       -> render() -> 'rendition-ready' -> setStyle()
                                                        -> setupRendition()
                                                        -> display() -> 'book-displayed'
*/

const open = (fileName, inputType, renderTo, options) => {
    book.open(decodeURI(fileName), inputType) // works for non-flatpak
        .catch(() => book.open(fileName, inputType)) // works for flatpak
        .catch(() => dispatch({ type: 'book-error' }))

    rendition = book.renderTo(renderTo, options)
}

book.ready.then(async () => {
    const hrefList = []

    // set the correct URL based on the path to the nav or ncx file
    // fixes https://github.com/futurepress/epub.js/issues/469
    const path = book.packaging.navPath || book.packaging.ncxPath
    const f = x => {
        x.label = x.label.trim()
        x.href = resolveURL(x.href, path)
        hrefList.push(x)
        x.subitems.forEach(f)
    }
    book.navigation.toc.forEach(f)

    // convert hrefs to CFIs for better TOC with anchor support
    cfiToc = await Promise.all(hrefList.map(async ({ label, href }) => {
        try {
            const result = await getCfiFromHref(href)
            const cfi = new ePub.CFI(result)
            cfi.collapse(true)
            return {
                label,
                href,
                cfi: cfi.toString()
            }
        } catch (e) {
            return null
        }
    }))
    try {
        cfiToc.sort(CFI.compare)
    } catch (e) {
        console.error(e)
    }

    const metadata = book.package.metadata
    if (metadata.description)
        metadata.description = toPangoMarkup(metadata.description)
    dispatch({ type: 'book-ready' })
})

const render = () =>
    rendition.display().then(() => dispatch({ type: 'rendition-ready' }))

const loadLocations = locations => {
    const locationsReady = () => {
        sectionMarks = book.spine.items.map(section => book.locations
            .percentageFromCfi('epubcfi(' + section.cfiBase + '!/0)'))
        dispatchLocation()
    }

    if (locations) {
        book.locations.load(locations)
        locationsReady()
        dispatch({ type: 'locations-ready' })
    } else {
        book.locations.generate(CHARACTERS_PER_PAGE)
            .then(() => locationsReady())
            .then(() => dispatch({
                type: 'locations-generated',
                payload: book.locations.save()
            }))
    }
}

const display = lastLocation =>
    rendition.display(lastLocation)
        .then(() => dispatch({ type: 'book-displayed' }))

// get book cover for "about this book" dialogue
book.loaded.resources
    .then(resources => resources.createUrl(book.cover))
    .then(blobUrl => fetch(blobUrl))
    .then(res => res.blob())
    .then(blob => {
        const reader = new FileReader()
        reader.readAsDataURL(blob)
        reader.onloadend = () => dispatch({
            type: 'cover',
            payload: reader.result.split(',')[1]
        })
    })
    .catch(() => dispatch({ type: 'cover', payload: null }))

const getRect = (target, frame) => {
    const rect = target.getBoundingClientRect()
    const viewElementRect =
        frame ? frame.getBoundingClientRect() : { left: 0, top: 0 }
    const left = rect.left + viewElementRect.left
    const right = rect.right + viewElementRect.left
    const top = rect.top + viewElementRect.top
    const bottom = rect.bottom + viewElementRect.top
    return { left, right, top, bottom }
}

const setupRendition = () => {
    const paginated = rendition.settings.flow === 'paginated'

    rendition.on('rendered', redrawAnnotations)
    rendition.on('relocated', dispatchLocation)

    const updateDivider = () => {
        const spread = paginated && rendition.settings.spread !== 'none'
            && document.getElementById('viewer').clientWidth >= 800
        // document.getElementById('divider').style.display =
        //     skeuomorphism && spread ? 'block' : 'none'
        dispatch({ type: 'spread', payload: spread })
    }
    rendition.on('layout', updateDivider)
    updateDivider()

    let isSelecting = false

    rendition.hooks.content.register((contents, /*view*/) => {
        const frame = contents.document.defaultView.frameElement

        // set lang attribute based on metadata
        // this is needed for auto-hyphenation
        const html = contents.document.documentElement
        if (!html.getAttribute('lang') && book.package.metadata.language)
            html.setAttribute('lang', book.package.metadata.language)

        html.setAttribute('__ibooks_internal_theme', ibooksInternalTheme)

        // hide EPUB 3 aside footnotes
        const asides = contents.document.querySelectorAll('aside')
        Array.from(asides).forEach(aside => {
            const type = aside.getAttribute('epub:type')
            if (type === 'footnote') aside.style.display = 'none'
        })

        const links = contents.document.querySelectorAll('a:link')
        Array.from(links).forEach(link => link.addEventListener('click', async e => {
            e.stopPropagation()
            e.preventDefault()

            const type = link.getAttribute('epub:type')
            const href = link.getAttribute('href')
            const id = href.split('#')[1]
            const pageHref = resolveURL(href,
                book.spine.spineItems[contents.sectionIndex].href)

            const followLink = () => dispatch({
                type: 'link-internal',
                payload: pageHref
            })

            if (isExternalURL(href))
                dispatch({ type: 'link-external', payload: href })
            else if (type !== 'noteref' && !enableFootnote) followLink()
            else {
                const item = book.spine.get(pageHref)
                if (item) await item.load(book.load.bind(book))

                let el = (item && item.document ? item.document : contents.document)
                    .getElementById(id)
                if (!el) return followLink()

                // this bit deals with situations like
                //     <p><sup><a id="note1" href="link1">1</a></sup> My footnote</p>
                // where simply getting the ID or its parent would not suffice
                // although it would still fail to extract useful texts for some books
                const isFootnote = el => {
                    const nodeName = el.nodeName.toLowerCase()
                    return [
                        'a', 'span', 'sup', 'sub',
                        'em', 'strong', 'i', 'b',
                        'small', 'big'
                    ].every(x => x !== nodeName)
                }
                if (!isFootnote(el)) {
                    while (true) {
                        const parent = el.parentElement
                        if (!parent) break
                        el = parent
                        if (isFootnote(parent)) break
                    }
                }

                if (item) item.unload()
                if (el.innerText.trim()) dispatch({
                    type: 'footnote',
                    payload: {
                        footnote: toPangoMarkup(el.innerHTML, pageHref),
                        // footnotes matching this would be hidden (see above)
                        // and so one cannot navigate to them
                        link: (el.nodeName === 'aside'
                            && el.getAttribute('epub:type') === 'footnote')
                            ? null : pageHref,
                        position: getRect(e.target, frame)
                    }
                })
                else followLink()
            }
        }, true))

        const imgs = contents.document.querySelectorAll('img')
        Array.from(imgs).forEach(img => img.addEventListener('click', e => {
            e.stopPropagation()
            fetch(img.src)
                .then(res => res.blob())
                .then(blob => {
                    const reader = new FileReader()
                    reader.readAsDataURL(blob)
                    reader.onloadend = () => dispatch({
                        type: 'img',
                        payload: {
                            alt: img.getAttribute('alt'),
                            base64: reader.result.split(',')[1],
                            position: getRect(e.target, frame)
                        }
                    })
                })
        }, true))

        // handle selection and clicks
        let timer = 0
        const dispatchClick = e => {
            const clientX = (e.changedTouches ? e.changedTouches[0] : e).clientX
            const left = e.target === document.documentElement ? 0 : frame
                .getBoundingClientRect().left
            const f = () => dispatch({
                 type: 'click',
                 payload: {
                    width: window.innerWidth,
                    position: clientX + left
                }
            })
            timer = setTimeout(f, doubleClickTime)
        }

        document.onclick = dispatchClick
        contents.document.onmousedown = () => isSelecting = true
        contents.document.onclick = e => {
            isSelecting = false

            const selection = contents.window.getSelection()
            // see https://stackoverflow.com/q/22935320
            if (!selection.rangeCount) return dispatchClick(e)

            const range = selection.getRangeAt(0)
            if (range.collapsed) return dispatchClick(e)

            clearTimeout(timer)
            dispatch({
                type: 'selection',
                payload: {
                    position: getRect(range, frame),
                    text: selection.toString(),
                    cfi: new ePub.CFI(range, contents.cfiBase).toString(),
                    language: book.package.metadata.language
                }
            })
        }

        // auto-hide cursor
        let timeout
        const hideCursor = () => {
            contents.document.documentElement.style.cursor = 'none'
            cursorHidden = true
        }
        const showCursor = () =>  {
            contents.document.documentElement.style.cursor = 'auto'
            cursorHidden = false
        }
        if (cursorHidden) hideCursor()
        contents.document.documentElement.addEventListener('mousemove', e => {
            // check whether the mouse actually moved
            // or the event is just triggered by something else
            if (e.screenX === myScreenX && e.screenY === myScreenY) return
            myScreenX = e.screenX, myScreenY = e.screenY
            showCursor()
            if (timeout) clearTimeout(timeout)
            if (autohideCursor) timeout = setTimeout(hideCursor, 1000)
        }, false)
    })

    // keyboard shortcuts
    const handleKeydown = event => {
        if (getWindowIsZoomed()) return
        const k = event.key
        if (k === 'ArrowLeft' || k === 'h') rendition.prev()
        else if(k === 'ArrowRight' || k === 'l') rendition.next()
        else if (k === 'Backspace') {
            if (paginated) rendition.prev()
            else window.scrollBy(0, -window.innerHeight)
        } else if (event.shiftKey && k === ' ' || k === 'ArrowUp' || k === 'PageUp') {
            if (paginated) rendition.prev()
        } else if (k === ' ' || k === 'ArrowDown' || k === 'PageDown') {
            if (paginated) rendition.next()
        } else if (k === 'j') {
            if (paginated) rendition.next()
            else window.scrollBy(0, lineHeight)
        } else if (k === 'k') {
            if (paginated) rendition.prev()
            else window.scrollBy(0, -lineHeight)
        }
    }
    rendition.on('keydown', handleKeydown)
    document.addEventListener('keydown', handleKeydown, false)

    if (paginated) {
        // scroll through pages
        const onwheel = debounce(event => {
            if (getWindowIsZoomed()) return
            const { deltaX, deltaY } = event
            if (Math.abs(deltaX) > Math.abs(deltaY)) {
                if (deltaX > 0) rendition.next()
                else if (deltaX < 0) rendition.prev()
            } else {
                if (deltaY > 0) rendition.next()
                else if (deltaY < 0) rendition.prev()
            }
            event.preventDefault()
        }, 100, true)
        document.documentElement.onwheel = onwheel

        // go to the next page when selecting to the end of a page
        // this makes it possible to select across pages
        rendition.on('selected', debounce(cfiRange => {
            if (!isSelecting) return
            const selCfi = new ePub.CFI(cfiRange)
            selCfi.collapse()
            const compare = CFI.compare(selCfi, rendition.location.end.cfi) >= 0
            if (compare) rendition.next()
        }, 1000))
    }
}

dispatch({ type: 'ready' })
