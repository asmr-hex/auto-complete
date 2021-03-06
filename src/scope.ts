import {
    Pattern,
    Word,
    Lookup,
} from './types'

import { Dictionary } from './dictionary'
import { Node } from './node'
import { LookupNode } from './lookup'
import { Suggestion } from './suggestion'
import { NormalizePattern } from './util'
import { isWord, isLookup } from './typegaurds'


/**
 * <p align="center"> 
 *   <img src="https://web.archive.org/web/20091026172159/http://geocities.com/simms_huijnen/Animations/osciloscope.gif">
 *   <img src="https://web.archive.org/web/20091026172159/http://geocities.com/simms_huijnen/Animations/osciloscope.gif">
 *   <img src="https://web.archive.org/web/20091026172159/http://geocities.com/simms_huijnen/Animations/osciloscope.gif">
 * </p>
 *
 * A `Scope` is the top-level [[Node|node]] of a Phrase [Trie](https://en.wikipedia.org/wiki/Trie) --
 * a trie of (trie)s which allows not only matching next characters, but also next words. This class
 * exposes methods for adding, removing, and suggesting patterns.
 *
 * As a technical note, a `Scope`'s value is `null`, thus all patterns within a scope are
 * accessible through the [[NextNodes.word|`Scope.next.word`]] or [[NextNodes.lookup|`Scope.next.lookup`]].
 */
export class Scope extends Node {

    /**
     * Constructs a `Scope`.
     * @param dictionary typically a reference to the dictionary this scope is contained within.
     * @param patterns an array of patterns to initially add to this scope.
     */
    constructor(readonly dictionary: Dictionary, patterns: Pattern[] = []) {
        super(null)

        // add provided patterns to our trie.
        for (const pattern of patterns) { this.add(pattern) }
    }

    /**
     * Adds a [[Term|term]] or [[Pattern|pattern]] to the scope.
     */
    public add(pattern: Word | Lookup | Pattern) {
        let words = NormalizePattern(pattern)

        if (words.length === 0) return

        // TODO validate pattern.
        // TODO handle empty strings as Words by skipping.
        // (gaurantees each word has at least one character)

        let node: Node = this

        // this ensures that the root node of the Trie does not have any next.chars
        // rather, the null root acts as the last char of the previous word in a pattern
        // this is a simplifying structure for the algorithm.
        if (isWord(words[0])) {
            ({ node, pattern: words } = this._addFirstCharOfNextWord(this, words))
        }

        this._add(node, words)
    }

    /**
     * Removes a [[Pattern|pattern]] from the scope.
     */
    public remove(pattern: Pattern) { }

    /**
     * Given a sequence of input tokens, returns an array of [[Suggestion|suggested completions]].
     *
     * @param input a sequence of input tokens.
     * @param lookahead how many tokens to resolve in lookups which occur immediately after input. See [[Dictionary.lookahead|lookahead]].
     */
    public suggest(input: Word | Word[], lookahead: number = 0): Suggestion[] {
        let suggestions: Suggestion[] = []

        // normalize input to be an array (if only given a string)
        if (!Array.isArray(input)) input = [input]

        // find matches with no remainder and extract their lookup-stacks
        const stacks = this.matchPattern(input).filter(m => m.remainder.length === 0).map(m => m.nodes)

        for (const stack of stacks) {
            suggestions = suggestions.concat(this._unwind(stack, input, lookahead))
        }

        return suggestions
    }


    private _add(node: Node, pattern: Pattern, isLastWord: boolean = false) {
        if (pattern.length === 0) return
        if (pattern.length === 1) isLastWord = true

        let nextNodes: Node[] = []
        let next: Word | Lookup = pattern[0]
        if (isWord(next)) nextNodes = [this._addChars(node, next, isLastWord)]
        if (isLookup(next)) nextNodes = this._addLookup(node, next, isLastWord)

        if (isLastWord) return

        pattern = pattern.slice(1)
        next = pattern[0]
        for (let nextNode of nextNodes) {
            let nextPattern = pattern
            if (isWord(next)) {
                const result = this._addFirstCharOfNextWord(nextNode, pattern)
                nextNode = result.node
                nextPattern = result.pattern
            }

            this._add(nextNode, nextPattern)
        }
    }

    private _addFirstCharOfNextWord(node: Node, pattern: Pattern): { node: Node, pattern: Pattern } {
        const word = pattern[0] as Word
        const c = word[0]

        // check if this node has already been made
        if (!(c in node.next.word)) node.next.word[c] = new Node(c)
        node = node.next.word[c]

        if (word.length === 1 && pattern.length === 1) {
            node.end = true
            return { node, pattern: [] }
        }

        pattern = ([word.substr(1)] as Pattern).concat(pattern.slice(1))

        return { node, pattern }
    }

    private _addChars(node: Node, word: Word, isLastWord: boolean = true): Node {
        if (word.length === 0) return node
        const c: string = word[0]
        if (!node.next.char[c]) node.next.char[c] = new Node(c)
        if (word.length === 1 && isLastWord) node.next.char[c].end = true

        // recurse until all has been consumed.
        if (word.length > 1) return this._addChars(node.next.char[c], word.slice(1), isLastWord)

        return node.next.char[c]
    }

    private _addLookup(node: Node, lookup: Lookup, isLastWord: boolean = true): Node[] {
        let nodes: Node[] = []
        for (let [alias, contexts] of Object.entries(lookup)) {
            // normalize contexts to always be an array
            if (!Array.isArray(contexts)) contexts = [contexts]

            let tries: Scope[] = []
            for (const context of contexts) {
                const trie = this.dictionary.scopes.get(context)
                if (!trie) throw new Error(`No such context '${context}'`) // TODO make this a type
                tries.push(trie)
            }

            const lookupNode = new LookupNode(alias, tries)
            if (isLastWord) lookupNode.end = true
            node.next.lookup[alias] = lookupNode
            nodes.push(lookupNode)
        }

        return nodes
    }

    private _unwind(stack: Node[], input: Word[], lookahead: number = 0): Suggestion[] {
        let suggestions: Suggestion[] = stack[0].completePattern([...input])

        // essentially reshape the `suggestions` array s.t. each resulting array of
        // suggestions from each subsequent node in the lookup-stack is concat'd.
        for (const node of stack.slice(1)) {
            for (const suggestion of node.completePattern([])) {
                let tmp: Suggestion[] = []
                for (const suggestion_i of suggestions) {
                    tmp.push(suggestion_i.concat(suggestion))
                }
                suggestions = tmp
            }
        }

        // return immediately if we don't require a lookahead.
        if (lookahead === 0) return suggestions

        // for each resulting suggestion, enforce a lookahead from the input offset
        let resolvedSuggestions: Suggestion[] = []
        for (const suggestion of suggestions) {
            resolvedSuggestions = resolvedSuggestions
                .concat(suggestion.resolveLookups(input, lookahead))
        }

        return resolvedSuggestions
    }
}
