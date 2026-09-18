package com.example;

public class Beta {

    public int combine(Alpha alpha, int factor) {
        int value = alpha.getBase();
        return value * factor + scale(value);
    }

    private int scale(int input) {
        Alpha helper = new Alpha(input);
        return helper.doubled();
    }
}
