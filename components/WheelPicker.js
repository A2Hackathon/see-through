import React, { useRef, useState, useEffect } from 'react';
import { Animated, View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const DEFAULT_COLORS = {
  labelText: '#8A8A8E',
  descriptionText: '#8A8A8E',
  pillBackground: '#FFFFFF',
  pillBorder: '#E5E5EA',
  pillText: '#1C1C1E',
  bubbleBackground: '#F4F4F5',
  curveColor: 'rgba(0,0,0,0.08)',
  thumbColor: '#2E2E2E',
};

/**
 * A vertically scrolling list of flat "quick action" cards.
 * The centered row is the active/highlighted one:
 * - Tapping the centered row fires onSelect(item, index) — use this to run an action.
 * - Tapping any other row scrolls it to center first.
 *
 * Same public API as before (data, initialIndex, visibleRows, itemHeight,
 * colors, onChangeIndex, onSelect) so callers don't need to change anything
 * besides passing an optional `description` on each data item.
 */
export default function WheelPicker({
  data,
  initialIndex = 0,
  visibleRows = 5,
  itemHeight = 92,
  colors,
  onChangeIndex,
  onSelect,
}) {
  if (!data || data.length === 0) {
    throw new Error('WheelPicker requires a non-empty `data` array.');
  }

  const theme = { ...DEFAULT_COLORS, ...colors };
  const wheelHeight = itemHeight * visibleRows;

  const scrollY = useRef(new Animated.Value(initialIndex * itemHeight)).current;
  const scrollRef = useRef(null);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  const paddingVertical = (wheelHeight - itemHeight) / 2;

  const settleOn = (index, animated = true) => {
    const clamped = Math.max(0, Math.min(data.length - 1, index));
    scrollRef.current?.scrollTo({ y: clamped * itemHeight, animated });
    setSelectedIndex(clamped);
    onChangeIndex && onChangeIndex(clamped, data[clamped]);
  };

  const handleMomentumEnd = (e) => {
    const y = e.nativeEvent.contentOffset.y;
    settleOn(Math.round(y / itemHeight));
  };

  const handlePressItem = (index) => {
    if (index === selectedIndex) {
      onSelect && onSelect(data[index], index);
    } else {
      settleOn(index);
    }
  };

  return (
    <View style={[styles.wrapper, { height: wheelHeight }]}>
      <Animated.ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        snapToInterval={itemHeight}
        decelerationRate="fast"
        bounces={false}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingVertical }}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        onMomentumScrollEnd={handleMomentumEnd}
      >
        {data.map((item, i) => (
          <WheelItem
            key={item.id}
            item={item}
            index={i}
            itemHeight={itemHeight}
            scrollY={scrollY}
            isSelected={i === selectedIndex}
            theme={theme}
            onPress={() => handlePressItem(i)}
          />
        ))}
      </Animated.ScrollView>
    </View>
  );
}
function WheelItem({ item, index, itemHeight, scrollY, isSelected, theme, onPress }) {
  const inputRange = [
    (index - 1) * itemHeight,
    index * itemHeight,
    (index + 1) * itemHeight,
  ];

  // Native-driven: wheel position effect (from scrollY)
  const scale = scrollY.interpolate({
    inputRange,
    outputRange: [0.94, 1, 0.94],
    extrapolate: 'clamp',
  });

  const opacity = scrollY.interpolate({
    inputRange,
    outputRange: [0.55, 1, 0.55],
    extrapolate: 'clamp',
  });

  // Native-driven: breathing scale pulse
  const pulseAnimScale = useRef(new Animated.Value(0)).current;
  // JS-driven: shadow pulse (shadow props can't use native driver)
  const pulseAnimShadow = useRef(new Animated.Value(0)).current;

  const scaleLoopRef = useRef(null);
  const shadowLoopRef = useRef(null);

  useEffect(() => {
    if (isSelected) {
      scaleLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnimScale, { toValue: 1, duration: 1100, useNativeDriver: true }),
          Animated.timing(pulseAnimScale, { toValue: 0, duration: 1100, useNativeDriver: true }),
        ])
      );
      scaleLoopRef.current.start();

      shadowLoopRef.current = Animated.timing(
        pulseAnimShadow,
        {
          toValue: 1,
          duration: 450,
          useNativeDriver: false,
        }
      );
      shadowLoopRef.current.start();
    } else {
      scaleLoopRef.current?.stop();
      shadowLoopRef.current?.stop();
      pulseAnimScale.setValue(0);
      shadowLoopRef.current = Animated.timing(
        pulseAnimShadow,
        {
          toValue: 0,
          duration: 300,
          useNativeDriver: false,
        }
      );
      shadowLoopRef.current.start();
    }

    return () => {
      scaleLoopRef.current?.stop();
      shadowLoopRef.current?.stop();
    };
  }, [isSelected]);

  const pulseScale = pulseAnimScale.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.015],
  });

  const glowRadius = pulseAnimShadow.interpolate({
    inputRange: [0, 1],
    outputRange: [4, 16],
  });
  const glowOpacity = pulseAnimShadow.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.24],
  });
  const glowElevation = pulseAnimShadow.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 8],
  });

  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, { height: itemHeight }]}
      accessibilityRole="button"
      accessibilityLabel={`${item.label}. ${item.description || ''}`}
      accessibilityHint={
        isSelected ? 'Activates this quick action' : 'Selects this quick action'
      }
      accessibilityState={{ selected: isSelected }}
    >
      {/* Layer 1 — native-driven wheel position effect only */}
      <Animated.View style={{ opacity, transform: [{ scale }], width: '94%', alignSelf: 'center' }}>

        {/* Layer 2 — JS-driven shadow only (no transform/native props here) */}
        <Animated.View
          style={{
            borderRadius: 20,
            shadowColor: item.color,
            shadowOpacity: glowOpacity,
            shadowRadius: glowRadius,
            shadowOffset: { width: 0, height: 4 },
            elevation: glowElevation,
          }}
        >

          {/* Layer 3 — native-driven pulse scale + actual card visuals */}
          <Animated.View
            style={[
              styles.card,
              {
                transform: [{ scale: pulseScale }],
                backgroundColor: theme.pillBackground,
                borderColor: isSelected ? theme.pillBackground : theme.pillBorder,
              },
            ]}
          >
            <View
              style={[
                styles.iconCircle,
                {
                  backgroundColor: isSelected ? item.color : theme.bubbleBackground,
                  borderColor: item.color,
                },
              ]}
            >
              <Ionicons name={item.icon} size={22} color={isSelected ? '#17150f' : item.color} />
            </View>

            <View style={styles.textBlock}>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                style={[styles.itemLabel, { color: theme.pillText }]}
              >
                {item.label}
              </Text>
              {item.description ? (
                <Text
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                  style={[styles.itemDescription, { color: theme.descriptionText }]}
                >
                  {item.description}
                </Text>
              ) : null}
            </View>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 24,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    marginRight: 14,
  },
  textBlock: {
    flex: 1,
  },
  itemLabel: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 16,
  },
  itemDescription: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 12.5,
    marginTop: 2,
  },
});