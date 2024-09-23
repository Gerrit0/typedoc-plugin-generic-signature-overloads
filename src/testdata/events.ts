export type Handler<
    EventType extends string,
    Event extends { type: string },
> = (event: Extract<Event, { type: EventType }>) => void;

export type Propagated<
    SourceTopic extends string,
    TargetTopic extends string,
    Event extends { type: string },
> = Event extends {
    type: string;
}
    ? Omit<Event, "type" | "topic"> & {
          type: `${SourceTopic}-${Event["type"]}`;
          topic: TargetTopic;
      }
    : never;

export type Foo = {
    type: "foo";
};

export type Bar = {
    type: "bar";
};

export type Baz = {
    type: "baz";
};

export namespace Topic {
    export namespace Subtopic {
        export type Event = (Foo | Bar | Baz) & { topic: "subtopic" };
        export function on<EventType extends string>(
            eventType: EventType,
            handler: Handler<EventType, Event>,
        ) {}
    }

    export type TopicEvent = (Foo | Bar | Baz) & { topic: "topic" };

    export type Event =
        | TopicEvent
        | Propagated<"subtopic", "topic", Subtopic.Event>;

    /** @expandGeneric */
    export function on<EventType extends Topic.Event["type"]>(
        eventType: EventType,
        handler: Handler<EventType, Event>,
    ) {}
}
